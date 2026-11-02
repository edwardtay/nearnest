// Minimal keyless NEAR RPC reads. No dependencies.
const RPC = process.env.NEAR_RPC || 'https://free.rpc.fastnear.com';
const ARCHIVAL = process.env.NEAR_ARCHIVAL_RPC || 'https://archival-rpc.mainnet.fastnear.com';

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'nearnest', method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  if (j.result?.error) throw new Error(`${method}: ${j.result.error}`);
  return j.result;
}

export async function view(contract, method, args = {}, blockId) {
  const params = {
    request_type: 'call_function',
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    ...(blockId ? { block_id: blockId } : { finality: 'final' }),
  };
  const r = await rpc(blockId ? ARCHIVAL : RPC, 'query', params);
  return JSON.parse(Buffer.from(r.result).toString());
}

export async function block(blockId) {
  const r = await rpc(blockId ? ARCHIVAL : RPC, 'block', blockId ? { block_id: blockId } : { finality: 'final' });
  return { height: r.header.height, ts: Number(BigInt(r.header.timestamp) / 1_000_000n) };
}

export async function accessKeys(accountId) {
  const r = await rpc(RPC, 'query', { request_type: 'view_access_key_list', finality: 'final', account_id: accountId });
  return r.keys;
}
