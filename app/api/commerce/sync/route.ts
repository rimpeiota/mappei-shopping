import { env } from 'cloudflare:workers';
import { apiError, json, readJson, requireOwner, requireSameOrigin } from '@/lib/server-http';
import { CommerceError, validCursor } from '@/lib/commerce-contract';
import { commerceSourceForOwner, fetchCommercePage, type CommerceEnvironment } from '@/lib/server-commerce-source';
import { syncCommerceNotifications } from '@/lib/server-commerce-store';

export const dynamic = 'force-dynamic';
export async function POST(request: Request): Promise<Response> {
  try {
    const owner = requireOwner(request); requireSameOrigin(request);
    const body = await readJson(request, 1024);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'revision') || !validCursor(body.revision)) {
      throw new CommerceError(400, '保存バージョンだけを送信してください。');
    }
    const runtime = env as CommerceEnvironment;
    const source = await commerceSourceForOwner(owner, runtime);
    if (!source) throw new CommerceError(503, 'このアカウントの通販連携を準備中です。');
    if (!runtime.DB) throw new CommerceError(503, '通販連携の保存先を準備中です。');
    return json(await syncCommerceNotifications(runtime.DB, owner, source.integrationId, body.revision,
      cursor => fetchCommercePage(source, cursor)));
  } catch (error) { return error instanceof CommerceError ? json({ error: error.message }, error.status) : apiError(error); }
}
