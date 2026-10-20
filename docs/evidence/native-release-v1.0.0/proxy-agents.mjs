// Configure the verifier's explicit standard-library agents with the managed
// environment proxy. Preserve every caller option, including TLS verification.
import https from 'node:https';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
const HttpsAgent = https.Agent;
const HttpAgent = http.Agent;
https.Agent = class extends HttpsAgent {
  constructor(options = {}) { super({ ...options, proxyEnv: process.env }); }
};
http.Agent = class extends HttpAgent {
  constructor(options = {}) { super({ ...options, proxyEnv: process.env }); }
};
syncBuiltinESMExports();
