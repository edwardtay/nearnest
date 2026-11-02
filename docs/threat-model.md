# NEARnest threat model

What each key can do, what stops it, and which drill check proves it. Drill checks are in [`demo/attack-testnet.json`](../demo/attack-testnet.json), each with its transaction.

## Actors and their powers

| Actor | Holds | Can | Cannot |
|---|---|---|---|
| Agent | a function-call key on the vault account, limited to `agent_supply`, `agent_withdraw`, `agent_claim_unstaked`, with a 0.5 NEAR gas allowance | move tokens between the vault and approved venues within the per-move cap, the venue's effective cap, the cooldown and the daily limit; exit any venue at any time | send NEAR, attach a deposit, call a token, call any owner or feeder method, pick a venue contract, supply into a blocked venue or a paused vault |
| Risk feeder | its own account | lower a venue's risk cap, block a venue with a reason, pause the vault, delete the agent key, pull funds from a venue back into the vault, claim unstaked NEAR | raise a cap, unblock, unpause, add a venue, send funds out of the vault/venue loop |
| Owner | its own account | everything above, plus add venues, raise or clear caps, unblock, unpause, set limits, restore the agent key, upgrade the code, withdraw from the vault to itself | send funds to anyone other than itself through the vault |
| Anyone | nothing | `sync_position` (re-reads the vault's holding from the venue), views | change any limit or move funds |

The vault account has no full-access key. Its code changes only through the owner's `update_contract`.

## Threats

| # | Threat | Stopped by | Drill check |
|---|---|---|---|
| 1 | Stolen agent key sends NEAR out | NEAR protocol: a function-call key cannot transfer | `send-native-near` |
| 2 | Stolen key calls `owner_withdraw` | NEAR protocol: method not on the key's list | `call-owner-withdraw` |
| 3 | Stolen key calls the token contract as the vault | NEAR protocol: wrong receiver and no deposit allowed | `call-token-directly` |
| 4 | Stolen key supplies into an attacker's pool | contract: venue must be approved; venue contracts are fixed at approval | `unknown-venue` |
| 5 | Stolen key moves everything at once | contract: per-move cap | `over-cap` |
| 6 | Stolen key fills a risky venue past the policy's size | contract: risk cap set by the feeder from the policy | `over-risk-cap` |
| 7 | Stolen key churns the vault | contract: cooldown and daily move limit | `cooldown` |
| 8 | Stolen key supplies into a hacked venue | contract: blocked venues refuse supply | `supply-blocked` |
| 9 | Compromised feeder loosens limits | contract: the feeder can only lower caps and cannot unblock | `feeder-raises-cap`, `feeder-unblock` |
| 10 | Agent key keeps acting after compromise is noticed | feeder or owner deletes the key | `kill-switch`, `dead-key` |
| 11 | Funds stuck in a venue after the key is gone | feeder or owner exits without the agent | `guardian-exit` |
| 12 | Books drift from what the venue holds (failed or partial exit, interest) | position re-read from the venue's `get_account` after every exit and claim | covered by unit tests; positions on the Vault view include interest |
| 13 | Unstaking NEAR vanishes from exposure | unbonding ledger counted against the venue cap until claimed | unit test `unbonding_counts_toward_the_venue_cap` |
| 14 | Policy acts on stale or missing data | fresh mainnet read before every signature, read timeouts, a missing price blocks the venue | JS tests |
| 15 | Poisoned risk data | the feed can only make the policy stricter on chain through the feeder; loosening needs the owner | `feeder-raises-cap` |

## What remains

- **Approved venues can still lose money.** The vault limits how much sits in a venue and exits quickly; it cannot undo a venue's own exploit.
- **Before the agent's next run, the risk cap is whatever the feeder last set.** A stolen key has that cap and the contract's limits until then.
- **The owner key is the root.** It can raise caps, unblock and upgrade the code. A multisig owner and a timelock on loosening are the next steps.
- **Exit liquidity and delays are the venue's.** A 97%-utilized pool or LiNEAR's 4-epoch unbonding delays an exit the vault allows.
- **Testnet.** The live vault runs on testnet against Burrow and LiNEAR testnet deployments, judged by mainnet data.
