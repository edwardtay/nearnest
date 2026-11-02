#!/usr/bin/env node
// Read-only view call. Usage: node view.mjs <network> <contract> <method> [jsonArgs]
const [net, contract, method, args = '{}'] = process.argv.slice(2);
const url = net === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://rpc.testnet.fastnear.com';
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'query',
    params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(args).toString('base64') },
  }),
});
const j = await res.json();
if (j.error || j.result?.error) { console.error(JSON.stringify(j.error || j.result.error).slice(0, 400)); process.exit(1); }
console.log(Buffer.from(j.result.result).toString());
