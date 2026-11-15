import { realpath, readdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StorageConfig } from "../config.js";
import { optional } from "../db/types.js";

/**
 * 파일 저장소 어댑터. 업무 매뉴얼·규정·양식 같은 "읽기용 문서"를 Claude 에 보여 준다.
 * 쓰기·삭제 기능은 일부러 없다.
 *
 * 안전장치(모든 저장소 공통):
 *  - 정해 둔 폴더(root + prefix) 밖은 보지 않는다. `..`·절대경로·심볼릭 링크로 빠져나가는 길을 막는다.
 *  - 허용한 확장자(MCP_STORAGE_EXT, 기본 .md,.txt)만 목록에 올리고 읽는다.
 *  - 파일 하나를 읽을 때 최대 크기를 둔다.
 */
export interface FileEntry {
  path: string;
  size: number;
  updated: string | null;
}

export interface Storage {
  label: string;
  list(): Promise<FileEntry[]>;
  readText(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }>;
}

const MAX_LIST = 500;

/** Claude 가 보낸 경로를 정리한다. 폴더 밖으로 나가는 경로는 거절한다. */
export function cleanPath(p: string, extensions: string[]): string {
  const s = p.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!s || isAbsolute(s) || s.startsWith("/") || s.split("/").some((x) => x === ".." || x === "")) {
    throw new Error("문서 경로가 올바르지 않다. manual_find 결과의 path 를 그대로 쓴다.");
  }
  if (!extensions.includes(extname(s).toLowerCase())) {
    throw new Error(`읽을 수 있는 문서 종류가 아니다(허용: ${extensions.join(", ")}).`);
  }
  return s;
}

const allowed = (name: string, ext: string[]) => ext.includes(extname(name).toLowerCase());

function clip(buf: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  const truncated = buf.length > maxBytes;
  /* 잘린 끝의 깨진 글자(한글 3바이트 중간)는 TextDecoder 가 대체 문자로 바꾼다. */
  return { text: new TextDecoder().decode(truncated ? buf.subarray(0, maxBytes) : buf), truncated };
}

async function localStorage(cfg: StorageConfig): Promise<Storage> {
  const root = await realpath(resolve(cfg.root));
  const walk = async (dir: string, out: FileEntry[]): Promise<void> => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (out.length >= MAX_LIST || d.name.startsWith(".")) continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) await walk(full, out);
      else if (d.isFile() && allowed(d.name, cfg.extensions)) {
        const st = await stat(full);
        out.push({ path: relative(root, full).split(sep).join("/"), size: st.size, updated: st.mtime.toISOString() });
      }
    }
  };
  return {
    label: `로컬 폴더 ${root}`,
    async list() {
      const out: FileEntry[] = [];
      await walk(root, out);
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
    async readText(p, maxBytes) {
      const rel = cleanPath(p, cfg.extensions);
      /* 심볼릭 링크를 따라간 실제 위치가 root 안인지 다시 확인한다. */
      const real = await realpath(join(root, rel)).catch(() => null);
      if (!real || (real !== root && !real.startsWith(root + sep))) throw new Error(`문서가 없다: ${rel}`);
      return clip(await readFile(real), maxBytes);
    },
  };
}

async function gcsStorage(cfg: StorageConfig): Promise<Storage> {
  const { Storage: Gcs } = await optional("@google-cloud/storage", "GCS 저장소");
  const bucket = new Gcs().bucket(cfg.root); // 로그인: gcloud auth application-default login
  return {
    label: `gs://${cfg.root}/${cfg.prefix}`,
    async list() {
      const [files] = await bucket.getFiles({ prefix: cfg.prefix, maxResults: MAX_LIST, autoPaginate: false });
      return (files as any[])
        .filter((f) => allowed(f.name, cfg.extensions))
        .map((f) => ({ path: f.name.slice(cfg.prefix.length), size: Number(f.metadata.size ?? 0), updated: f.metadata.updated ?? null }));
    },
    async readText(p, maxBytes) {
      const rel = cleanPath(p, cfg.extensions);
      const [buf] = await bucket.file(cfg.prefix + rel).download({ start: 0, end: maxBytes });
      return clip(buf, maxBytes);
    },
  };
}

async function s3Storage(cfg: StorageConfig): Promise<Storage> {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await optional("@aws-sdk/client-s3", "S3 저장소");
  const s3 = new S3Client({ region: cfg.s3Region }); // 로그인: aws sso login --profile …
  return {
    label: `s3://${cfg.root}/${cfg.prefix}`,
    async list() {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: cfg.root, Prefix: cfg.prefix, MaxKeys: MAX_LIST }));
      return ((r.Contents ?? []) as any[])
        .filter((o) => allowed(o.Key, cfg.extensions))
        .map((o) => ({ path: String(o.Key).slice(cfg.prefix.length), size: Number(o.Size ?? 0), updated: o.LastModified?.toISOString() ?? null }));
    },
    async readText(p, maxBytes) {
      const rel = cleanPath(p, cfg.extensions);
      const r = await s3.send(new GetObjectCommand({ Bucket: cfg.root, Key: cfg.prefix + rel, Range: `bytes=0-${maxBytes}` }));
      return clip(Buffer.from(await r.Body.transformToByteArray()), maxBytes);
    },
  };
}

async function azureStorage(cfg: StorageConfig): Promise<Storage> {
  const { BlobServiceClient } = await optional("@azure/storage-blob", "Azure Blob 저장소");
  const { DefaultAzureCredential } = await optional("@azure/identity", "Azure Blob 저장소 로그인");
  const container = new BlobServiceClient(cfg.azureAccountUrl!, new DefaultAzureCredential()).getContainerClient(cfg.root);
  return {
    label: `azure:${cfg.root}/${cfg.prefix}`,
    async list() {
      const out: FileEntry[] = [];
      for await (const b of container.listBlobsFlat({ prefix: cfg.prefix })) {
        if (out.length >= MAX_LIST) break;
        if (allowed(b.name, cfg.extensions)) {
          out.push({ path: b.name.slice(cfg.prefix.length), size: Number(b.properties.contentLength ?? 0), updated: b.properties.lastModified?.toISOString() ?? null });
        }
      }
      return out;
    },
    async readText(p, maxBytes) {
      const rel = cleanPath(p, cfg.extensions);
      const buf: Buffer = await container.getBlobClient(cfg.prefix + rel).downloadToBuffer(0, maxBytes + 1);
      return clip(buf, maxBytes);
    },
  };
}

export async function connectStorage(cfg: StorageConfig): Promise<Storage | null> {
  switch (cfg.kind) {
    case "none":
      return null;
    case "local":
      return localStorage(cfg);
    case "gcs":
      return gcsStorage(cfg);
    case "s3":
      return s3Storage(cfg);
    case "azure":
      return azureStorage(cfg);
  }
}
