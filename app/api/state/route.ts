import { env } from "cloudflare:workers";
import { ApiError, apiError, isRecord, json, readJson, requireOwner, requireSameOrigin } from "@/lib/server-http";

export const dynamic = "force-dynamic";
const MAX_STATE_BYTES = 1024 * 1024;
type StoredState = { state_json: string; revision: number };

function database(): D1Database {
  if (!env.DB) throw new ApiError(503, "クラウド保存を準備中です。端末の記録は残っています。");
  return env.DB;
}

async function getState(db: D1Database, owner: string): Promise<{ state: unknown; revision: number }> {
  const row = await db.prepare("SELECT state_json, revision FROM shopping_snapshots WHERE user_id = ?").bind(owner).first<StoredState>();
  return row ? { state: JSON.parse(row.state_json), revision: row.revision } : { state: null, revision: 0 };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const owner = requireOwner(request);
    return json({ ...await getState(database(), owner), owner, storage: "d1" });
  }
  catch (error) { return apiError(error); }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const owner = requireOwner(request);
    requireSameOrigin(request);
    const body = await readJson(request, MAX_STATE_BYTES + 1024);
    // This is a continuity check, not an ownership selector: the trusted header still owns the row.
    if (body.owner !== owner) throw new ApiError(403, "アカウントが切り替わりました。画面を再読み込みしてください。");
    if (!isRecord(body.state)) throw new ApiError(400, "保存するデータの形式を確認してください。");
    // Older clients discard recipe/inventory fields while reading a v2 snapshot.
    // Reject their writes before they can replace the account's complete state.
    if (body.state.version !== 2) throw new ApiError(426, "アプリの更新が必要です。端末のメモは残っています。画面を再読み込みしてください。");
    const pending: Array<{ value: unknown; depth: number }> = [{ value: body.state, depth: 0 }];
    while (pending.length) {
      const current = pending.pop()!;
      if (current.depth > 64) throw new ApiError(400, "保存するデータの階層が深すぎます。");
      if (current.value && typeof current.value === "object") {
        for (const value of Object.values(current.value)) pending.push({ value, depth: current.depth + 1 });
      }
    }
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) throw new ApiError(400, "保存バージョンの形式を確認してください。");
    const serialized = JSON.stringify(body.state);
    if (new TextEncoder().encode(serialized).byteLength > MAX_STATE_BYTES) throw new ApiError(413, "保存できるデータは1MBまでです。バックアップして記録を整理してください。");
    const revision = body.revision as number;
    const db = database();
    const now = new Date().toISOString();
    // One atomic statement per branch prevents stale writers from overwriting new data.
    const updated = revision === 0
      ? await db.prepare("INSERT INTO shopping_snapshots (user_id, state_json, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING RETURNING revision")
        .bind(owner, serialized, now).first<{ revision: number }>()
      : await db.prepare("UPDATE shopping_snapshots SET state_json = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ? RETURNING revision")
        .bind(serialized, now, owner, revision).first<{ revision: number }>();
    if (!updated) return json(await getState(db, owner), 409);
    return json({ revision: updated.revision });
  } catch (error) { return apiError(error); }
}
