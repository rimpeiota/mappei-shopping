import { connect } from 'cloudflare:sockets';
import { ReadOnlyImap } from './imap.ts';
import { collect, handleRequest, type Env } from './service.ts';

const open = () => new ReadOnlyImap(connect({ hostname: 'imap.spmode.ne.jp', port: 993 }, { secureTransport: 'on', allowHalfOpen: false }));
export default {
  fetch(request: Request, env: Env) { return handleRequest(request, env, open); },
  async scheduled(_controller: ScheduledController, env: Env) {
    await collect(env, open);
  },
} satisfies ExportedHandler<Env>;
