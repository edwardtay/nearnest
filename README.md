# NEARnest

A yield agent on NEAR that is held to an on-chain policy. It reads live yields and risk across NEAR lending and liquid staking, decides where the money should sit, and moves it through a vault contract that refuses anything outside the owner's rules. A stolen agent key can only make the moves the agent was already allowed to make.

Live page: https://nearnest.web3wagmi.com

## Try it in two minutes

1. **See the policy judge real yields.** Open the live page, or run `node agent/scan.mjs`. You see mainnet rates read from the venue contracts. Rhea Lend USDC pays the most (10.7% on 9 November 2026), and the agent caps it at 50% of its venue limit, because Rhea Lend lost $18.4M on 16 April 2026 (about $11.2M since returned or frozen) and its pool was 86.8% lent out that day.
2. **See the vault on chain.** Open [`v2.nearnest-mvz1l0ba.testnet`](https://testnet.nearblocks.io/address/v2.nearnest-mvz1l0ba.testnet) and its access keys. It has one key, a function-call key limited to `agent_supply`, `agent_withdraw` and `agent_claim_unstaked`. There is no full-access key.
3. **See the agent move money.** The Overview shows the position, blended yield and the agent's next move, computed live. The Agent view links each transaction, each with the policy reasons recorded at the time.
   Under **NEAR AI proposals** a model on NEAR AI Cloud proposes the move instead, and the policy accepts it, cuts it to the bound, or refuses it. On mainnet the model proposed staking all 0.71 idle NEAR in LiNEAR; the policy cut it to the 0.5 NEAR cap and the agent signed that ([C6ZBVv…](https://nearblocks.io/txns/C6ZBVvRpmnHUdoxvCCUg9jXeAxVkFRrQFNKiB69KAvwg)), after the risk feeder had capped Rhea USDC on chain ([4rNvUZ…](https://nearblocks.io/txns/4rNvUZ5n39sTbfqqf48RXBgvWBuAxaAYTBKDVcUhTfHG)). On testnet one proposal was signed and executed. In another, a hostile instruction was planted in the data; the model ignored it and proposed a normal supply. Three rows show what the check does with a compromised model's answers (an unapproved account, an oversize supply, a venue the policy holds). Each real proposal links its request, reply and signature; see [NEAR AI proposer](#near-ai-proposer) for how to check them.
4. **Ask "what if".** The What if view applies one event to the live mainnet read (USDC at $0.991, a fresh Rhea or LiNEAR exploit, a drained USDC pool, or the April hack ageing out) and runs the same policy and planner against the vault. For the depeg it also shows the recorded testnet response: the risk feeder blocked Burrow USDC, the agent key pulled the 12.5 USDC out, the owner reopened the venue and the agent went back in.
5. **See a stolen key fail.** The Drill view runs 28 checks with the real keys. 24 have a transaction; the other 4 (a transfer, `owner_withdraw`, a direct token call, the deleted key) are refused by NEAR's access-key check before a transaction exists, and the drill records that error instead. 14 attempts are refused, each with its own reason: a transfer, `owner_withdraw`, a direct token call, an unapproved venue, an oversize move, a move inside the cooldown, a move past the daily limit, a supply past the on-chain risk cap, a supply while paused, a supply into a blocked venue, the deleted agent key, and the risk feeder trying to raise a cap, unpause or unblock. 14 permitted operations go through, including exits while paused or blocked, the feeder deleting the agent key and exiting without it, and the owner restoring everything.

6. **Make your own vault.** In My vault, connect a NEAR testnet wallet and create `<name>.nearnest-factory-mvzmesjc.testnet` in one transaction. The factory deploys the vault, adds the agent's function-call key (no full-access key) and makes you the owner. Fund it with test USDC and NEAR, and the agent runs it under the same rules; the owner buttons withdraw to you, pause, and remove or restore the agent's key.
7. **Fund from any chain.** In My vault, pick a token you hold on its own chain (ETH on Base, USDC on Solana, USDT on Tron, BTC and others) and an amount, and press Get a live quote. NEAR Intents solvers price the swap through the 1Click API, and you see what the vault would receive in NEAR USDC, the route's cost and the time to settle. Or run `node scripts/fund-intents.mjs base:ETH 0.01`. See [Fund from any chain](#fund-from-any-chain) for why these quotes are dry until the mainnet vault is live.

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

### NEAR AI proposer

[`agent/proposer.mjs`](agent/proposer.mjs), run with `node scripts/run-agent.mjs --ai`. A model on NEAR AI Cloud (default `z-ai/glm-5.3`, set `NEARAI_MODEL` to change it) gets the facts the planner reads: live rates, each venue's verdict and reasons, positions, on-chain caps, idle balances, moves left today. It answers with one move as JSON. `checkProposal` holds that move to the planner's bound for the venue: a supply is cut to what the policy step allows or refused when the policy holds, a withdrawal is cut to the position and per-move cap, and a venue the vault never approved is refused. Then the vault contract checks the move again on chain. The model can make the agent do less than the policy allows, never more. Blocks, cap cuts and policy exits stay deterministic: the risk feeder never waits on a model.

Every proposal carries a signature you can check yourself:

1. `GET /api/ai/evidence?chat_id=<id>` returns the exact request and response bytes, the signed text and the signature.
2. `sha256(request) + ":" + sha256(response)` equals the signed text.
3. The EIP-191 signer recovered from the signature is `0xb98a789cdc4817275f5155593ba73ef2a957e779`.
4. `GET https://cloud-api.near.ai/v1/attestation/report?model=z-ai/glm-5.3&signing_algo=ecdsa` names that address as the gateway's signing key, inside an Intel TDX quote from a dstack TEE, and reports the model attestation as verified.

The agent runs steps 2 to 4 on every proposal and records the result. It does not verify the TDX quote itself against Intel's certificates. `--inject` plants a hostile instruction in the data feed (prompt-injection drill), and `--hostile` replaces the model's answer with a compromised model's, to show the check refusing it; those rows are marked simulated and sign nothing.

### Fund from any chain

A vault takes deposits in NEAR USDC, but most people hold their money on other chains. [`agent/intents.mjs`](agent/intents.mjs) uses the NEAR Intents 1Click API: the user sends a token to a one-time deposit address on its own chain, solvers fill the swap inside NEAR Intents, and 1Click sends NEAR USDC to the vault with `ft_transfer`. The vault needed no change: it registers for USDC storage when it is created and keeps any token it receives (`ft_on_transfer` returns 0), and the agent finds the new USDC idle on its next round and supplies it under the usual caps. Nobody but the owner can take it out.

NEAR Intents runs on mainnet only. The page quotes into the mainnet vault (see [Deployed](#deployed)); its quotes are dry: live mainnet prices and routes, with no deposit address. The script quotes to `intents.near`, an existing mainnet account registered for USDC, unless you pass `--to <vault>`. 1Click answers a bare HTTP 500 when the recipient account does not exist or has no USDC storage, so the server and script check both on mainnet first and say which one is missing. A real deposit is `node scripts/fund-intents.mjs base:USDC 2 --to <mainnet vault> --live --refund <your Base address>`: it prints the deposit address, follows the swap to SUCCESS or REFUNDED and logs it to `demo/intents-mainnet.json`. You send the funds from your own wallet, and the script holds no key. Refunds go to the origin-chain address you give.

### Factory

[`factory/src/lib.rs`](factory/src/lib.rs) embeds the vault's wasm. `create_vault(name)` with at least `get_min_deposit` attached (about 4.1 NEAR, almost all of it the vault code's storage) runs one batch on `<name>.<factory>`: create the account, transfer the deposit, deploy the vault, add the agent's function-call key, call `new_preset` with the caller as owner. If the batch fails (a taken name, out of gas) the deposit is credited back and claimed with `claim_refund`; the first visitor vault on testnet failed this way and its refund went through. The factory keeps none of the deposit. On mainnet, NEAR global contracts would let every vault share one copy of the code instead of paying 3.3 NEAR of storage each.

### Contract interface

| Who | Methods |
|---|---|
| Agent key (signer must be the registered key) | `agent_supply`, `agent_withdraw`, `agent_claim_unstaked` |
| Risk feeder or owner | `set_risk_cap` (the feeder can only lower it), `block_venue`, `pause`, `remove_agent_key`, `guardian_exit`, `guardian_claim` |
| Owner | `add_venue`, `set_venue_enabled`, `unblock_venue`, `clear_risk_cap`, `set_max_move`, `set_policy`, `set_risk_feeder`, `set_agent_key`, `add_agent_key`, `unpause`, `storage_deposit_on`, `owner_withdraw`, `update_contract` |
| Anyone | `sync_position` (reads the vault's holding from the venue), `get_vault`, `get_venues` |

Moves, blocks, cap changes, pauses, key removal and contract upgrades emit NEP-297 events under the `nearnest` standard. The owner's configuration setters (`set_policy`, `set_max_move`, `set_risk_feeder`, `set_agent_key`, `set_venue_enabled`) do not; read them with `get_vault` and `get_venues`.

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
# build first: the factory embeds the vault wasm (the --cfg near flag keeps panic messages readable)
rustup target add wasm32-unknown-unknown
./factory/build.sh             # builds contract/ then factory/

# policy, planner, scenario and contract tests (38 JS, 31 Rust)
npm test

# live mainnet scan, no keys needed
node agent/scan.mjs            # table
node agent/scan.mjs --json     # full report

# testnet: create owner, feeder and vault, approve venues, add the agent key
cd scripts && npm install
node testnet-setup.mjs         # keys are written to ../keys/testnet.json (gitignored, mode 600)
node run-agent.mjs --dry       # print the plan
node run-agent.mjs --loop      # make the moves, waiting out the vault cooldown; risk is re-read before every signature
node run-agent.mjs --watch 30  # run again every 30 minutes in the foreground
node run-agent.mjs --scenario usdc-depeg   # respond to a simulated event for real
node owner-unblock.mjs burrow-usdc         # owner reopens the venue afterwards
node owner-upgrade.mjs                     # owner deploys new vault code, then syncs positions
node factory-setup.mjs                     # testnet factory plus one visitor vault, end to end
node run-all.mjs --loop                    # the agent for the demo vault and every factory vault
node attack.mjs                # the compromised-key drill, writes demo/attack-testnet.json
node run-agent.mjs --ai --dry           # NEAR AI proposes, the policy checks; needs keys/near-ai.txt
node run-agent.mjs --ai                 # same, then signs the checked move
node run-agent.mjs --ai --inject --dry  # prompt-injection drill
node run-agent.mjs --ai --hostile --dry # compromised-model drill (simulated, nothing signed)
node fund-intents.mjs sol:USDC 25            # dry NEAR Intents quote: USDC on Solana -> NEAR USDC
node fund-intents.mjs base:USDC 2 --to <mainnet vault> --live --refund 0x...   # real deposit

# the page
cd .. && npm start             # http://localhost:8787
```

## Deployed

**Mainnet** (real funds, small caps: 50 USDC and 0.5 NEAR in total, 20 USDC per move, 6 moves a day):

| Role | Account |
|---|---|
| Vault | [`2b2d2d4d5675f16ee97064a858d17e8eea546dc1a2358f63962a81fae9c88a3e`](https://nearblocks.io/address/2b2d2d4d5675f16ee97064a858d17e8eea546dc1a2358f63962a81fae9c88a3e) |
| Owner | `web3wagmi.near` |
| Risk feeder | `fb10a8ba67ae2563bb36f165bf641c22449488867557e3dac34df82e6a685498` |
| Setup | [one transaction](https://nearblocks.io/txns/F4AsUkFdDDj4FAEkXfZc9qJXSo4mEwk8AQ2YyJxFeoyb): deploy, `new_preset`, agent key added, setup key deleted |

The vault is an implicit account (its id is the hex of a one-time key) because Meteor Wallet blocks apps from deploying code or adding keys, so a named sub-account could not be set up from a wallet. The owner only sent NEAR to it. The one-time key deployed the same code as the testnet vault (code hash `9MVQzf2KvbZfha31UG3qNqAgem5N6UuNs47bNhqBq8LR`), made `web3wagmi.near` the owner, added the agent's function-call key and deleted itself in the same transaction, so the vault has no full-access key. Checks and links: [`demo/deployment-mainnet.json`](demo/deployment-mainnet.json). Fund from any chain now quotes into this vault.

**Testnet:**

| Role | Account |
|---|---|
| Factory | [`nearnest-factory-mvzmesjc.testnet`](https://testnet.nearblocks.io/address/nearnest-factory-mvzmesjc.testnet) |
| First visitor vault | [`demo.nearnest-factory-mvzmesjc.testnet`](https://testnet.nearblocks.io/address/demo.nearnest-factory-mvzmesjc.testnet) |
| Vault | [`v2.nearnest-mvz1l0ba.testnet`](https://testnet.nearblocks.io/address/v2.nearnest-mvz1l0ba.testnet) |
| Owner | `nearnest-mvz1l0ba.testnet` |
| Risk feeder | `risk.nearnest-mvz1l0ba.testnet` |
| Agent key | `ed25519:cyDjVHGtPhCnGKtJjzdWaqRQvXySSbnAr7m3vw2akbF` |

Setup transactions are in [`demo/deployment-testnet.json`](demo/deployment-testnet.json), the agent's moves in [`demo/agent-testnet.json`](demo/agent-testnet.json) and the drill in [`demo/attack-testnet.json`](demo/attack-testnet.json).

## Repository

```
contract/   Rust vault contract and unit tests
factory/    Rust factory: anyone creates their own vault in one call
web/        builds public/js/wallet.js (NEAR Wallet Selector); the server needs no install
agent/      venue reads, risk policy, report builder, scan CLI, policy tests
scripts/    testnet setup, agent run loop, attack drill, inspection helpers
demo/       public deployment ids and recorded runs (no secrets)
public/     the web page
server.mjs  app server and JSON endpoints (/api/scan, /api/vault, /api/plan, /api/agent, /api/drill, /api/scenario, /api/ai, /api/fund/*)
```

## Limits

- The mainnet vault holds about 3.3 NEAR as contract storage, which stays locked unless a later `update_contract` adds a way to close it.
- An AI proposal whose signature does not verify is refused and never executed.
- The NEAR AI proposer runs only when the agent is started with `--ai`; the hosted agent's moves so far came from the deterministic planner, except the one marked NEAR AI.
- The page's Fund from any chain quotes are dry (no deposit address); a real deposit runs with `scripts/fund-intents.mjs --live`. 1Click sets minimums on some routes (currently $100 from Tron).
- One vault serves one owner. Shares for several depositors are out of scope.
- A Burrow withdrawal settles in a later receipt; if Burrow's transfer back failed and Burrow re-credited the vault, the next `sync_position` (callable by anyone) corrects the books.
- Policy caps reach the chain on the agent's next run, so a stolen key has the contract's caps until then. The risk feeder holds no funds and can run on its own.
- The policy reads incidents from DefiLlama's hacks list, so a new exploit reaches the agent when DefiLlama records it. The risk feeder exists to block faster than that.

## Built with AI

The contract, agent, scripts and page were written with Claude Code (Anthropic) under my direction, and idea selection was discussed with Codex (OpenAI). Every on-chain claim above links to a transaction you can check.

## License

MIT, see [LICENSE](LICENSE).
