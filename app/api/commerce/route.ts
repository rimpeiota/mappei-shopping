import { env } from 'cloudflare:workers';
import { apiError, json, requireOwner } from '@/lib/server-http';
import { CommerceError, disconnectedCommerceStatus } from '@/lib/commerce-contract';
import { commerceSourceForOwner, type CommerceEnvironment } from '@/lib/server-commerce-source';
import { readCommerceStatus } from '@/lib/server-commerce-store';

export const dynamic = 'force-dynamic';
export async function GET(request: Request): Promise<Response> {
  try {
    const owner = requireOwner(request);
    const runtime = env as CommerceEnvironment;
    const source = await commerceSourceForOwner(owner, runtime);
    if (!source) return json(disconnectedCommerceStatus());
    if (!runtime.DB) throw new CommerceError(503, '通販連携の保存先を準備中です。');
    return json(await readCommerceStatus(runtime.DB, owner, source.integrationId));
  } catch (error) { return error instanceof CommerceError ? json({ error: error.message }, error.status) : apiError(error); }
}
