# NEARnest yield venues (live research, 2026-11-02)

All numbers below were pulled live on 2026-11-02 (NEAR block ~222,696,857) from the FastNEAR public RPC, the FastNEAR archival RPC and DefiLlama. Read-only: nothing was signed or sent. The commands to rerun everything are at the bottom.

NEAR price (DefiLlama coins): $4.13.

## Summary table

| Venue | Contract id (verified) | Asset | Yield now | Base vs emissions | Exit |
|---|---|---|---|---|---|
| Rhea Lend (ex Burrow) | `contract.main.burrow.near` | native USDC | 14.43% APR (15.5% APY compounded daily) | 100% base, farm has no rewards | `execute` Withdraw, 1 yocto; utilization 89% |
| Rhea Lend | `contract.main.burrow.near` | USDt | 12.08% APR | 100% base | same; utilization 88% |
| Rhea Lend | `contract.main.burrow.near` | wNEAR (`wrap.near`) | 0.33% APR | 100% base | same; utilization 17% |
| LiNEAR | `linear-protocol.near` | NEAR to LiNEAR | 4.54% APY (30.4-day realized) | 100% staking rewards | delayed unstake, 4 epochs; no instant pool on chain |
| Meta Pool | `meta-pool.near` | NEAR to stNEAR | 4.06% APY (30.4-day realized) | 100% staking rewards | `liquid_unstake` (0.54% fee now, 75,980 NEAR liquidity) or 4-epoch delayed unstake |
| Rhea LST | `lst.rhealab.near` | NEAR to rNEAR | 4.54% APY (30.4-day realized); DefiLlama 4.56% | 100% base | LiNEAR-style interface |

## 1. Rhea Lend (formerly Burrow)

The live Rhea lending contract is still `contract.main.burrow.near`. Proof: `get_config` returns `contract_mode: "Running"`, `owner_id: burrow.sputnik-dao.near`, `ref_exchange_id: v2.ref-finance.near`, `enable_pyth_oracle: true`, `pause_operator_id: null`; `get_version` returns `"0.16.2"`. Its asset list already includes Rhea-era tokens (`xtoken.rhealab.near`, `lst.rhealab.near`), so there is no separate Rhea lending account. Source: github.com/ref-finance/burrowland (last push 2025-12-02).

View methods:
- `get_assets_paged_detailed {"from_index":0,"limit":40}`: every asset with `supply_apr`, `borrow_apr`, `supplied.balance`, `borrowed.balance`, `config.can_deposit`, `config.can_withdraw`, `config.extra_decimals`, `config.supplied_limit`, and `farms`.
- `get_asset {"token_id":...}`: one asset.
- `get_account {"account_id":...}`: a user's supplied/collateral/borrowed positions (null if unregistered).
- `get_asset_farm {"farm_id":{"TokenNetBalance":<token>}}`: reward farm for an asset.
- `storage_balance_bounds`: min 0.1 NEAR (`100000000000000000000000`).
- `get_config`, `get_version`.

Balances inside Burrow use internal decimals: token decimals + `extra_decimals`. USDC and USDT have 6 token decimals and `extra_decimals: 12`, so internal values are 18 decimals.

Live state of the three target assets:

| Asset | token_id | supply_apr | borrow_apr | Supplied | Borrowed | Utilization | Supply cap |
|---|---|---|---|---|---|---|---|
| USDC | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | 0.14429 | 0.21554 | 12,891,934 | 11,506,748 | 89.3% | 60M |
| USDt | `usdt.tether-token.near` | 0.12077 | 0.18350 | 12,309,670 | 10,802,156 | 87.8% | 60M |
| wNEAR | `wrap.near` | 0.00326 | 0.02491 | 3,426,165 NEAR | 597,497 NEAR | 17.4% | 3.6M NEAR |

Emissions vs base: the supply-side farms for all three are empty (`TokenNetBalance` farm `rewards: {}` for USDC and USDt, `Supplied` farm `rewards: {}` for wNEAR). The whole supply APR is borrower interest. DefiLlama agrees: `rhea-lend` USDC apy 14.41 (apyBase 14.41, apyReward null, 30d mean 10.87), USDT apy 12.08 (apyBase 12.08, apyReward null, 30d mean 10.16). DefiLlama reports the APR figure in its `apy` field. DefiLlama pool TVL is about supplied minus borrowed ($1.59M USDC, $1.71M USDT), which is roughly the withdrawable cash.

Bridged variants are also live: USDC.e (`a0b86991...factory.bridge.near`) 11.15%, USDT.e (`dac17f95...factory.bridge.near`) 10.06%, DAI 13.34%, FRAX 13.89%, all small (<$100k net).

Deposit flow (from `fungible_token.rs`):
1. One time: `storage_deposit` on `contract.main.burrow.near` with 0.1 NEAR attached (payable, the vault attaches it from its own balance).
2. Call `ft_transfer_call` on the token contract (for example the USDC account) with 1 yoctoNEAR attached:
   `{"receiver_id":"contract.main.burrow.near","amount":"<raw units>","msg":""}`
   - `msg: ""` = plain supply (earns supply APR, not collateral).
   - `msg: "{\"Execute\":{\"actions\":[{\"IncreaseCollateral\":{\"token_id\":\"<token>\",\"amount\":null}}]}}"` = supply and mark as collateral. NEARnest does not borrow, so plain supply is enough.
   - Other variants in `TokenReceiverMsg`: `ExecuteWithPyth`, `DepositToReserve`, `DepositToMargin`, `MarginExecute`, `OnlyIncreaseCollateral`, `OnlyRepay`.
   - `ft_on_transfer` asserts `config.can_deposit`.

Withdraw flow:
- `execute {"actions":[{"Withdraw":{"token_id":"<token>","max_amount":"<internal units, optional>"}}]}` with exactly 1 yoctoNEAR attached (`#[payable]`, "Requires one yoctoNEAR"). `amount: null` / no `max_amount` withdraws the maximum available.
- With no borrows the health check needs no price data, so plain `execute` works. `execute_with_pyth` exists for accounts with debt.
- Burrow then sends the token back with `ft_transfer`, so the vault must be storage-registered on the USDC/USDT token contracts.
- Liquidity risk: at 88 to 89% utilization only about $1.4M USDC and $1.5M USDt can be withdrawn right now. A large vault position could be stuck until borrowers repay or rates push utilization down.

## 2. LiNEAR (`linear-protocol.near`)

Verified: `ft_metadata` returns `LiNEAR` / `LINEAR`, 24 decimals; `contract_source_metadata` returns version `1.6.2`, github.com/linear-protocol/LiNEAR.

- Price: `ft_price` = `1429221706330365476244711`, so 1 LiNEAR = 1.42922 NEAR.
- `get_summary`: 13,768,228 NEAR staked, 448 validators, 9,633,375 LiNEAR shares.
- APY: price on archival block 218,270,000 (2026-10-03) was 1.423950; 30.39 days later 1.429222. Realized APY 4.54% (APR 4.45%). All of it is staking rewards (protocol fee goes to `linear.sputnik-dao.near`, `get_beneficiaries` = 600 bps). DefiLlama has a protocol entry (`linear-protocol`, Near TVL $56.7M, -18% over 7 days) but no yield pool on chain Near.
- Stake: `deposit_and_stake` (payable, attach NEAR) mints LiNEAR. Also `deposit` then `stake(amount)` / `stake_all`.
- Unstake: `unstake(amount)` or `unstake_all`, then `withdraw(amount)` / `withdraw_all` after 4 epochs (`NUM_EPOCHS_TO_UNLOCK = 4`, about 2 to 3 days at 12h epochs plus settlement).
- Instant unstake: the old liquidity pool is gone in v1.6.2 (`get_liquidity_pool_info` returns MethodNotFound). Instant exit means selling LiNEAR on Rhea DEX (`v2.ref-finance.near`, 8,994 pools).
- None of these methods asserts 1 yocto, so the vault can call them directly; `deposit_and_stake` needs the vault to attach real NEAR from its own balance (fine for a cross-contract promise). If the vault holds wNEAR it must first call `near_withdraw` on `wrap.near` (1 yocto).

## 3. Meta Pool (`meta-pool.near`)

Verified: `ft_metadata` returns `Staked NEAR` / `STNEAR`, 24 decimals; `get_contract_info` returns `Metapool` 2.0.0, github.com/Meta-Pool/liquid-staking-contract.

- Price: `get_st_near_price` = `1513289231254676276377333`, so 1 stNEAR = 1.51329 NEAR.
- `get_contract_state`: 21,589,366 NEAR for staking, 586 staking pools, 21,001 accounts, `min_deposit_amount` 1 NEAR, NSLP (instant-unstake pool) liquidity 75,980 NEAR vs 80,000 target, current discount 54 bps (min 30, max 500).
- APY: 1.508279 on block 218,270,000, 1.513289 now. Realized APY 4.06% (APR 3.99%). All staking rewards; `operator_rewards_fee_basis_points` 980. `staker_meta_mult_pct` is 0, so no mpDAO emissions to stakers. DefiLlama protocol `meta-pool-near` Near TVL $90.0M, no Near yield pool listed.
- Stake: `deposit_and_stake` (payable, attach NEAR, min 1 NEAR). No `ft_on_transfer` for wNEAR, so unwrap first.
- Instant unstake: `liquid_unstake {"st_near_to_burn":"...","min_expected_near":"..."}`. The `assert_one_yocto` is commented out in source on purpose for function-call keys. Capacity is only about 76k NEAR and the fee rises toward 5% as the pool drains.
- Delayed unstake: `unstake(amount)` / `unstake_all`, then `withdraw_unstaked` after 4 epochs (up to 8 if all pools are unstaking).
- stNEAR `ft_transfer` / `ft_transfer_call` assert 1 yocto (standard).

## 4. Other NEAR yield venues with TVL > $1M (DefiLlama)

`yields.llama.fi/pools` lists only 10 pools on chain Near. Pools above $1M:

| Project | Pool | TVL | APY | apyBase | apyReward | 30d mean |
|---|---|---|---|---|---|---|
| rhea-lst | rNEAR (`lst.rhealab.near`, underlying wrap.near) | $76.7M | 4.56 | 4.56 | null | 4.60 |
| rhea-lst | xRHEA (`xtoken.rhealab.near`, "exit fee up to 10%") | $6.99M | 3.77 | 3.77 | null | 3.75 |
| rhea-lend | USDT | $1.71M | 12.08 | 12.08 | null | 10.16 |
| rhea-lend | USDC | $1.59M | 14.41 | 14.41 | null | 10.87 |

Largest pool under $1M: rhea-dex stable pool USDT-USDC-USDT.E-USDC.E, $104.6k TVL, 8.14% base.

rNEAR is verified on chain: `ft_metadata` = "Rhea Liquid Near Staking Token" / rNEAR; `contract_source_metadata` v1.0.2, github.com/rhea-finance/rnear-contract; `get_summary` 18,794,240 NEAR staked, 125 validators; `ft_price` 1.067718 NEAR, realized 30-day APY 4.54%. It uses the LiNEAR interface (`get_summary`, `ft_price`), so the same adapter can serve both. xRHEA is a single-sided RHEA staking token with up to 10% exit fee; it is a governance-token position, not a fit for a stable vault.

Protocols with Near TVL > $1M from `api.llama.fi/protocols` (excluding CEXs): Rhea Lend $161.3M (gross, includes collateral), NEAR Intents $107.0M (bridge), Meta Pool Near $90.0M, RHEA LST $77.4M, LiNEAR $56.7M, NEAR Bridge $49.0M, Rhea Dex $25.6M, Portal $6.3M (bridge), KAIO $4.0M (RWA, permissioned), Jumbo Exchange $1.26M (DEX). Templar Protocol (lending) is $666k, HERE Wallet staking $961k, Allstake $618k, all below the bar.

## 5. Stablecoin contracts (ft_metadata)

- `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`: spec ft-1.0.0, name "USDC", symbol "USDC", decimals 6. Native Circle USDC.
- `usdt.tether-token.near`: spec ft-1.0.0, name "Tether USD", symbol "USDt", decimals 6. Native Tether.

Both are accepted by Rhea Lend (`can_deposit: true`, `can_withdraw: true`). Do not confuse them with the bridged `a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near` (USDC.e) and `dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near` (USDT.e).

## 6. Incidents in 2026 (api.llama.fi/hacks)

- **Rhea Lend, 2026-04-16, $18.4M, oracle manipulation (spot price).** DefiLlama: the attacker deployed fake tokens and eight Ref Finance pools over April 13 to 15, then ran a chained swap path that defeated the margin module's slippage protection; the oracle accepted attacker-created pool prices. `returnedFunds: null`. The contract shows `contract_mode: "Running"` today. This is the venue's main risk flag; the exploit hit the margin trading module, which NEARnest does not use, but supplied stablecoins share the same reserves.
- **Sweat Foundation, 2026-04-29, $3.5M, withdrawal logic flaw** in the SWEAT token contract on NEAR. Stolen tokens were dumped via MEXC and Rhea. Not a NEARnest venue.
- **NEAR Intents, 2026-10-01, $3.8M, bridge logic flaw** (Omni deposit/withdraw interaction; listed under chain BSC). Services were paused, the team said losses would be compensated. Relevant only if NEARnest routes funds through Intents.
- Meta Pool's listed incident is 2025-06-17 ($130k, mpETH ERC4626 unprotected mint on Ethereum), not the NEAR stNEAR contract.
- Older NEAR entries: Ref Finance 2021-08-15 ($3.2M), Skyward Finance 2022-11-02 ($3M).
- No entries for LiNEAR or Rhea LST.

## 7. Function-call key constraint check

From docs.near.org:
- Access Keys page (docs.near.org/protocol/access-keys): "Function-Call keys can only sign transactions calling a specific contract, and do not allow to attach NEAR tokens to the call." They are defined by `receiver_id`, optional `method_names`, and an optional gas `allowance`.
- Require one yoctoNEAR page (docs.near.org/smart-contracts/security/one_yocto): exactly one yoctoNEAR "cannot be attached with a function-call key", which is why sensitive methods require it.
- Cross-contract calls page (docs.near.org/smart-contracts/anatomy/crosscontract): each promise carries "The NEAR deposit to attach (deducted from your contract's balance)", set with `.with_attached_deposit(DEPOSIT)` or `Promise::new(..).function_call(name, args, DEPOSIT, GAS)`.

Conclusion: the design works. The agent's function-call key (receiver = vault, method_names = the agent methods) calls a non-payable vault method. The vault then creates its own promises (`ft_transfer_call` to Burrow with 1 yocto, `execute` Withdraw with 1 yocto, `storage_deposit` with 0.1 NEAR, `deposit_and_stake` with real NEAR), and those deposits come from the vault's own balance. The restriction applies only to the transaction the key signs. Design rules that follow:
- Agent-callable vault methods must not be `#[payable]` and must not `assert_one_yocto`.
- The vault must keep a NEAR balance for yocto deposits, storage registration and staking.
- The vault must enforce its own allowlist (venue ids, max amounts, slippage) because the key alone only limits which vault methods can be called.
- Gas for the agent's transactions is paid from the key's allowance on the signer account.

## Blockers and risks

1. Rhea Lend stablecoin utilization is 88 to 89%. High APR is real base yield, but withdrawable cash is only about $1.4M USDC and $1.5M USDt.
2. Rhea Lend lost $18.4M in April 2026 (margin/oracle path). Show this in the agent's risk scoring.
3. LiNEAR has no on-chain instant unstake; exits are 4 epochs or a DEX swap.
4. Meta Pool instant unstake capacity is about 76k NEAR.
5. DefiLlama yields has no pools for LiNEAR or Meta Pool on Near; compute their APY from on-chain price change (method below).
6. Staking venues need native NEAR attached; a vault holding wNEAR must `near_withdraw` from `wrap.near` (1 yocto) first.

## Rerun commands

Helper for view calls (args are base64 JSON):

```bash
cat > view.sh <<'EOF'
#!/bin/bash
# usage: ./view.sh <account> <method> '<json args>'
ARGS=$(printf '%s' "${3:-{\}}" | base64 -w0)
curl -s https://free.rpc.fastnear.com -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$ARGS\"}}" \
 | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d.get("result",{});print(bytes(r["result"]).decode() if "result" in r else d)'
EOF
chmod +x view.sh

# same call at a past block, via archival RPC
cat > viewat.sh <<'EOF'
#!/bin/bash
# usage: ./viewat.sh <block_height> <account> <method> '<json args>'
ARGS=$(printf '%s' "${4:-{\}}" | base64 -w0)
curl -s https://archival-rpc.mainnet.fastnear.com -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"block_id\":$1,\"account_id\":\"$2\",\"method_name\":\"$3\",\"args_base64\":\"$ARGS\"}}" \
 | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d.get("result",{});print(bytes(r["result"]).decode() if "result" in r else d)'
EOF
chmod +x viewat.sh
```

Rhea Lend:

```bash
./view.sh contract.main.burrow.near get_config '{}'
./view.sh contract.main.burrow.near get_version '{}'
./view.sh contract.main.burrow.near get_assets_paged_detailed '{"from_index":0,"limit":40}'
./view.sh contract.main.burrow.near get_asset '{"token_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"}'
./view.sh contract.main.burrow.near get_asset_farm '{"farm_id":{"TokenNetBalance":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"}}'
./view.sh contract.main.burrow.near storage_balance_bounds '{}'
./view.sh contract.main.burrow.near get_account '{"account_id":"<vault>.near"}'
```

Liquid staking:

```bash
./view.sh linear-protocol.near ft_price '{}'
./view.sh linear-protocol.near get_summary '{}'
./view.sh linear-protocol.near contract_source_metadata '{}'
./view.sh meta-pool.near get_st_near_price '{}'
./view.sh meta-pool.near get_contract_state '{}'
./view.sh meta-pool.near get_contract_params '{}'
./view.sh lst.rhealab.near ft_price '{}'
./view.sh lst.rhealab.near get_summary '{}'

# 30-day realized APY: compare price now with price at a block ~30 days ago
# (blocks are ~0.59 s apart; 218270000 was 2026-10-03)
./viewat.sh 218270000 linear-protocol.near ft_price '{}'
./viewat.sh 218270000 meta-pool.near get_st_near_price '{}'
./viewat.sh 218270000 lst.rhealab.near ft_price '{}'
curl -s https://archival-rpc.mainnet.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"block","params":{"block_id":218270000}}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["header"]["timestamp"])'
# APY = (p_now/p_then)^(365*86400/seconds_between) - 1
```

Tokens:

```bash
./view.sh 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 ft_metadata '{}'
./view.sh usdt.tether-token.near ft_metadata '{}'
./view.sh lst.rhealab.near ft_metadata '{}'
./view.sh xtoken.rhealab.near ft_metadata '{}'
./view.sh v2.ref-finance.near get_number_of_pools '{}'
```

DefiLlama:

```bash
curl -s https://yields.llama.fi/pools | python3 -c '
import sys,json
for x in sorted([p for p in json.load(sys.stdin)["data"] if p["chain"]=="Near"], key=lambda p:-p["tvlUsd"]):
  print(x["project"], x["symbol"], round(x["tvlUsd"]), x["apy"], x["apyBase"], x["apyReward"], x.get("apyMean30d"), x["pool"])'

curl -s https://api.llama.fi/protocols | python3 -c '
import sys,json
ps=[p for p in json.load(sys.stdin) if "Near" in (p.get("chains") or [])]
for p in sorted(ps, key=lambda p:-(p.get("chainTvls",{}).get("Near") or 0))[:30]:
  print(p["name"], p["slug"], p.get("category"), round(p.get("chainTvls",{}).get("Near") or 0))'

curl -s https://api.llama.fi/hacks | python3 -c '
import sys,json,datetime
for h in json.load(sys.stdin):
  s=json.dumps(h).lower()
  if any(k in s for k in ("near","rhea","burrow","ref finance","linear","meta pool")):
    print(datetime.date.fromtimestamp(h["date"]), h["name"], h["chain"], h["amount"], h["technique"])'

curl -s "https://coins.llama.fi/prices/current/coingecko:near"
```

Source files read (for method signatures and yocto rules):

```bash
curl -s https://raw.githubusercontent.com/ref-finance/burrowland/main/contracts/contract/src/fungible_token.rs
curl -s https://raw.githubusercontent.com/ref-finance/burrowland/main/contracts/contract/src/actions.rs
curl -s https://raw.githubusercontent.com/linear-protocol/LiNEAR/main/contracts/linear/src/stake.rs
curl -s https://raw.githubusercontent.com/Meta-Pool/liquid-staking-contract/master/metapool/src/lib.rs
```
