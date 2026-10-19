// Local named-framework fixture. Only public loopback configuration uses stdin.
import { createServer } from '../../../apps/web/node_modules/vite/dist/node/index.js';
let input = '';
for await (const part of process.stdin) input += part;
const { root, target } = JSON.parse(input);
const server = await createServer({
  configFile: false,
  root,
  logLevel: 'silent',
  server: {
    host: '127.0.0.1',
    port: 0,
    proxy: {
      '/ws': { target, ws: true },
      '/write': { target },
    },
  },
});
await server.listen();
process.stdout.write(
  JSON.stringify({ url: server.resolvedUrls.local[0] }) + '\n',
);
const close = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
