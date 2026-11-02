# NEARnest

A yield agent on NEAR that is held to an on-chain policy. It reads live yields and risk across NEAR lending and liquid staking, decides where the money should sit, and moves it through a vault contract that refuses anything outside the owner's rules. A stolen agent key can only make the moves the agent was already allowed to make.

Live page: https://nearnest.web3wagmi.com

## Try it in two minutes

1. **See the policy judge real yields.** Open the live page, or run `node agent/scan.mjs`. You see mainnet rates read from the venue contracts. Rhea Lend USDC pays the most, about 14%, and the agent caps it at 50% of its venue limit, because Rhea Lend lost $18.4M on 16 April 2026 (about $11.2M since returned or frozen) and its pool is about 89% lent out.
2. **See the vault on chain.** Open [`v2.nearnest-mvz1l0ba.testnet`](https://testnet.nearblocks.io/address/v2.nearnest-mvz1l0ba.testnet) and its access keys. It has one key, a function-call key limited to `agent_supply`, `agent_withdraw` and `agent_claim_unstaked`. There is no full-access key.
3. **See the agent move money.** The Overview shows the position, blended yield and the agent's next move, computed live. The Agent view links each transaction, each with the policy reasons recorded at the time.
4. **Ask "what if".** The What if view applies one event to the live mainnet read (USDC at $0.991, a fresh Rhea or LiNEAR exploit, a drained USDC pool, or the April hack ageing out) and runs the same policy and planner against the vault. For the depeg it also shows the recorded testnet response: the risk feeder blocked Burrow USDC, the agent key pulled the 12.5 USDC out, the owner reopened the venue and the agent went back in.
5. **See a stolen key fail.** The Drill view runs 28 checks with the real keys, each with its transaction. 14 attempts are refused, each with its own reason: a transfer, `owner_withdraw`, a direct token call, an unapproved venue, an oversize move, a move inside the cooldown, a move past the daily limit, a supply past the on-chain risk cap, a supply while paused, a supply into a blocked venue, the deleted agent key, and the risk feeder trying to raise a cap, unpause or unblock. 14 permitted operations go through, including exits while paused or blocked, the feeder deleting the agent key and exiting without it, and the owner restoring everything.

To repeat steps 3 to 5 yourself you need the testnet keys, which stay local. Set up your own vault with the commands under [Run it](#run-it).

## How it works

```
 mainnet RPC + DefiLlama            agent (off chain)                     vault (on chain)
 ───────────────────────  read   ─────────────────────   agent key    ──────────────────────────
 Rhea Lend rates, util.  ──────▶ policy.mjs judges each  ───────────▶ checks venue approved,
 LiNEAR / rNEAR prices           venue: allow, cap, block  function   not blocked, per-move cap,
 hacks, stablecoin prices        run-agent.mjs sizes and   call only  venue cap, cooldown, daily
                                 orders the moves                     limit, then calls the venue
                                         │
                                         └── risk feeder key ───────▶ set_risk_cap (lower only),
                                                                      block_venue(reason), pause,
                                                                      remove_agent_key, guardian_exit
```

Three layers, each one narrower than the last:

1. **NEAR access keys.** The agent's key is a function-call key on the vault account with a gas allowance. NEAR rejects a transfer, a deposit, or any other method before the transaction runs.
2. **The vault contract** (`contract/src/lib.rs`, Rust, near-sdk 5). It only sends funds to venues the owner approved, in amounts under the per-move and per-venue caps, with a cooldown and a daily move limit. The vault's rules never stop an exit request, even from a blocked venue or a paused vault; the venue's own liquidity and LiNEAR's unbonding delay still apply. After every exit and claim the vault reads its holding back from the venue's `get_account`, so its books follow the venue (interest included), and LiNEAR NEAR that is unbonding stays counted against the venue cap until it is claimed. Only the owner can withdraw from the vault, and only to the owner.
3. **The off-chain policy** (`agent/policy.mjs`). It adds what the chain cannot see:
   - an exploit in the last 90 days blocks a venue
   - an exploit in the last 365 days caps it at 25% (funds not returned) or 50% (returned); this covers protocols a venue depends on
   - lending utilization of 95% or more blocks; 85% or more caps at 50%
   - the vault never holds more than 1% of what can leave a lending pool right now
   - a stablecoin 0.5% or more off its peg blocks every venue holding it, and a missing price blocks it too
   - yield counts the base rate; token rewards are flagged and left out
   - incidents come from DefiLlama's hacks feed, with sourced corrections in [`agent/incident-notes.json`](agent/incident-notes.json) where the feed lags (it lists the April Rhea Lend hack with no returned funds; The Block reports about $11.2M returned or frozen)

A separate risk-feeder account can lower a venue's cap, block a venue with a reason, pause the vault, delete the agent key, and pull funds from a venue back into the vault (`guardian_exit`, `guardian_claim`), so the owner can recover funds after the agent key is gone. It cannot raise a cap, unblock, unpause or send funds anywhere: those stay with the owner, the same split as a Morpho vault's sentinel and curator.

The policy's sizes reach the chain. When the policy wants less in a venue than the contract allows, the agent's run has the risk feeder call `set_risk_cap` with the policy size (the 25% and 50% caps and the 1% exit-liquidity ceiling, in the vault's own token units). From then on a stolen agent key is held to the policy's size too. When risk eases, the agent waits and the owner decides whether to raise the cap.

The full authority table, threats and the drill check behind each are in [`docs/threat-model.md`](docs/threat-model.md).

### What if

[`agent/scenarios.mjs`](agent/scenarios.mjs) changes the live inputs the way a real event would and reruns the unchanged policy and planner. The page shows the verdicts and plans side by side (`/api/scenario?id=usdc-depeg`). `run-agent.mjs --scenario <id>` makes the vault respond for real on testnet, and `owner-unblock.mjs` reopens the venue afterwards.

| Scenario | Policy response |
|---|---|
| `usdc-depeg`: USDC at $0.991 | blocks Rhea Lend USDC; block, then exit |
| `rhea-exploit`: $12M Rhea Lend exploit today | blocks Rhea USDC, USDt and rNEAR (rNEAR depends on Rhea Lend) |
| `linear-exploit`: $8M LiNEAR exploit today | blocks LiNEAR; unstake |
| `usdc-run`: USDC pool at 97% utilization | blocks Rhea Lend USDC; exit |
| `year-later`: 18 April 2027 | the April incident ages out; rNEAR goes to full size, the lending pools stay capped by utilization |

### Contract interface

| Who | Methods |
|---|---|
| Agent key (signer must be the registered key) | `agent_supply`, `agent_withdraw`, `agent_claim_unstaked` |
| Risk feeder or owner | `set_risk_cap` (the feeder can only lower it), `block_venue`, `pause`, `remove_agent_key`, `guardian_exit`, `guardian_claim` |
| Owner | `add_venue`, `set_venue_enabled`, `unblock_venue`, `clear_risk_cap`, `set_max_move`, `set_policy`, `set_risk_feeder`, `set_agent_key`, `add_agent_key`, `unpause`, `storage_deposit_on`, `owner_withdraw`, `update_contract` |
| Anyone | `sync_position` (reads the vault's holding from the venue), `get_vault`, `get_venues` |

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
# policy, planner, scenario and contract tests (27 JS, 25 Rust)
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
node run-agent.mjs --loop      # make the moves, waiting out the vault cooldown; risk is re-read before every signature
node run-agent.mjs --watch 30  # run again every 30 minutes in the foreground
node run-agent.mjs --scenario usdc-depeg   # respond to a simulated event for real
node owner-unblock.mjs burrow-usdc         # owner reopens the venue afterwards
node owner-upgrade.mjs                     # owner deploys new vault code, then syncs positions
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
server.mjs  app server and JSON endpoints (/api/scan, /api/vault, /api/plan, /api/agent, /api/drill, /api/scenario)
```

## Limits

- The vault runs on testnet. A mainnet vault needs about 4 NEAR for contract storage.
- One vault serves one owner. Shares for several depositors are out of scope.
- A Burrow withdrawal settles in a later receipt; if Burrow's transfer back failed and Burrow re-credited the vault, the next `sync_position` (callable by anyone) corrects the books.
- Policy caps reach the chain on the agent's next run, so a stolen key has the contract's caps until then. The risk feeder holds no funds and can run on its own.
- The policy reads incidents from DefiLlama's hacks list, so a new exploit reaches the agent when DefiLlama records it. The risk feeder exists to block faster than that.

## Built with AI

The contract, agent, scripts and page were written with Claude Code (Anthropic) under my direction, and idea selection was discussed with Codex (OpenAI). Every on-chain claim above links to a transaction you can check.

## License

MIT, see [LICENSE](LICENSE).
