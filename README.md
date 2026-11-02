# NEARnest

A yield agent on NEAR that is held to an on-chain policy. It reads live yields and risk across NEAR lending and liquid staking, decides where the money should sit, and moves it through a vault contract that refuses anything outside the owner's rules. A stolen agent key can only make the moves the agent was already allowed to make.

Live page: https://nearnest.web3wagmi.com

## Try it in two minutes

1. **See the policy judge real yields.** Open the live page, or run `node agent/scan.mjs`. You see mainnet rates read from the venue contracts. Rhea Lend USDC pays the most, about 14%, and the agent caps it at 25% of its venue limit, because Rhea Lend lost $18.4M on 16 April 2026 with funds not returned, and its pool is about 89% lent out.
2. **See the vault on chain.** Open [`v2.nearnest-mvz1l0ba.testnet`](https://testnet.nearblocks.io/address/v2.nearnest-mvz1l0ba.testnet) and its access keys. It has one key, a function-call key limited to `agent_supply`, `agent_withdraw` and `agent_claim_unstaked`. There is no full-access key.
3. **See the agent move money.** The Overview shows the position, blended yield and the agent's next move, computed live. The Agent view links each transaction: 12.5 USDC into Burrow (capped) and 1 NEAR into LiNEAR (allowed), each with the policy reasons recorded at the time.
4. **See a stolen key fail.** The "Attack drill" section lists 12 attempts made with the real agent key. Transfers, `owner_withdraw`, direct token calls, unknown venues, oversize moves, moves inside the cooldown and moves into a blocked venue are all refused, each with its own reason. Exiting a blocked venue goes through.

To repeat steps 3 and 4 yourself you need the testnet keys, which stay local. Set up your own vault with the commands under [Run it](#run-it).

## How it works

```
 mainnet RPC + DefiLlama            agent (off chain)                     vault (on chain)
 ───────────────────────  read   ─────────────────────   agent key    ──────────────────────────
 Rhea Lend rates, util.  ──────▶ policy.mjs judges each  ───────────▶ checks venue approved,
 LiNEAR / rNEAR prices           venue: allow, cap, block  function   not blocked, per-move cap,
 hacks, stablecoin prices        run-agent.mjs sizes and   call only  venue cap, cooldown, daily
                                 orders the moves                     limit, then calls the venue
                                         │
                                         └── risk feeder key ───────▶ block_venue(reason), pause,
                                                                      remove_agent_key
```

Three layers, each one narrower than the last:

1. **NEAR access keys.** The agent's key is a function-call key on the vault account with a gas allowance. NEAR rejects a transfer, a deposit, or any other method before the transaction runs.
2. **The vault contract** (`contract/src/lib.rs`, Rust, near-sdk 5). It only sends funds to venues the owner approved, in amounts under the per-move and per-venue caps, with a cooldown and a daily move limit. Withdrawals are always allowed, even from a blocked venue or a paused vault, so leaving risk is never delayed. Only the owner can withdraw from the vault, and only to the owner.
3. **The off-chain policy** (`agent/policy.mjs`). It adds what the chain cannot see:
   - an exploit in the last 90 days blocks a venue
   - an exploit in the last 365 days caps it at 25% (funds not returned) or 50% (returned); this covers protocols a venue depends on
   - lending utilization of 95% or more blocks; 85% or more caps at 50%
   - the vault never holds more than 1% of what can leave a lending pool right now
   - a stablecoin 0.5% or more off its peg blocks every venue holding it
   - yield counts the base rate; token rewards are flagged and left out

A separate risk-feeder account can block a venue with a reason, pause the vault or delete the agent key. It cannot unblock, unpause or move funds: those stay with the owner.

### Contract interface

| Who | Methods |
|---|---|
| Agent key (signer must be the registered key) | `agent_supply`, `agent_withdraw`, `agent_claim_unstaked` |
| Risk feeder or owner | `block_venue`, `pause`, `remove_agent_key` |
| Owner | `add_venue`, `set_venue_enabled`, `unblock_venue`, `set_max_move`, `set_policy`, `set_risk_feeder`, `set_agent_key`, `add_agent_key`, `unpause`, `storage_deposit_on`, `owner_withdraw`, `update_contract` |
| Anyone | `get_vault`, `get_venues` |

Every state change emits a NEP-297 event under the `nearnest` standard.

### Venues

| Venue | Mainnet | Testnet |
|---|---|---|
| Rhea Lend (Burrow) USDC, USDt | `contract.main.burrow.near` | `contract.1638481328.burrow.testnet` with `usdc.fakes.testnet` |
| LiNEAR | `linear-protocol.near` | `linear-protocol.testnet` |
| Rhea rNEAR | `lst.rhealab.near` | scan only |

The testnet vault takes its judgement from the matching mainnet venue, since testnet markets have no real risk signal. Research notes on each venue are in [`docs/venues.md`](docs/venues.md).

## Run it

Requirements: Node 20+, Rust 1.86 with the `wasm32-unknown-unknown` target.

```bash
# policy and contract tests (10 JS, 16 Rust)
npm test

# live mainnet scan, no keys needed
node agent/scan.mjs            # table
node agent/scan.mjs --json     # full report

# build the contract (the --cfg near flag keeps panic messages readable)
cd contract && ./build.sh && cd ..

# testnet: create owner, feeder and vault, approve venues, add the agent key
cd scripts && npm install
node testnet-setup.mjs         # keys are written to ../keys/testnet.json (gitignored, mode 600)
node run-agent.mjs --dry       # print the plan
node run-agent.mjs --loop      # make the moves, waiting out the vault cooldown
node attack.mjs                # the compromised-key drill, writes demo/attack-testnet.json

# the page
cd .. && npm start             # http://localhost:8787
```

## Deployed

| Role | Account |
|---|---|
| Vault | [`v2.nearnest-mvz1l0ba.testnet`](https://testnet.nearblocks.io/address/v2.nearnest-mvz1l0ba.testnet) |
| Owner | `nearnest-mvz1l0ba.testnet` |
| Risk feeder | `risk.nearnest-mvz1l0ba.testnet` |
| Agent key | `ed25519:cyDjVHGtPhCnGKtJjzdWaqRQvXySSbnAr7m3vw2akbF` |

Setup transactions are in [`demo/deployment-testnet.json`](demo/deployment-testnet.json), the agent's moves in [`demo/agent-testnet.json`](demo/agent-testnet.json) and the drill in [`demo/attack-testnet.json`](demo/attack-testnet.json).

## Repository

```
contract/   Rust vault contract and unit tests
agent/      venue reads, risk policy, report builder, scan CLI, policy tests
scripts/    testnet setup, agent run loop, attack drill, inspection helpers
demo/       public deployment ids and recorded runs (no secrets)
public/     the web page
server.mjs  app server and JSON endpoints (/api/scan, /api/vault, /api/plan, /api/agent, /api/drill)
```

## Limits

- The vault runs on testnet. A mainnet vault needs about 4 NEAR for contract storage.
- One vault serves one owner. Shares for several depositors are out of scope.
- The policy reads incidents from DefiLlama's hacks list, so a new exploit reaches the agent when DefiLlama records it. The risk feeder exists to block faster than that.

## Built with AI

The contract, agent, scripts and page were written with Claude Code (Anthropic) under my direction, and idea selection was discussed with Codex (OpenAI). Every on-chain claim above links to a transaction you can check.

## License

MIT, see [LICENSE](LICENSE).
