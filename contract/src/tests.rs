use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const VAULT: &str = "vault.owner.near";
const OWNER: &str = "owner.near";
const FEEDER: &str = "risk.near";
const USDC: &str = "usdc.near";
const RHEA: &str = "rhea-lending.near";
const UNIT: u128 = 1_000_000; // 1 USDC

fn agent_pk() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}
fn other_pk() -> PublicKey {
    "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847".parse().unwrap()
}

fn ctx(predecessor: &str, signer_pk: PublicKey, ts_s: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(VAULT.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .signer_account_pk(signer_pk)
        .account_balance(NearToken::from_near(10))
        .block_timestamp(ts_s * 1_000_000_000);
    testing_env!(b.build());
}

fn as_agent(ts_s: u64) {
    ctx(VAULT, agent_pk(), ts_s);
}
fn as_owner() {
    ctx(OWNER, other_pk(), 1_000);
}

fn setup() -> Vault {
    as_owner();
    let mut v = Vault::new(
        OWNER.parse().unwrap(),
        agent_pk(),
        Policy { cooldown_s: 3_600, max_moves_per_day: 3 },
    );
    v.set_risk_feeder(Some(FEEDER.parse().unwrap()));
    v.add_venue(
        "rhea-usdc".into(),
        Venue {
            kind: VenueKind::LendingFt,
            contract: RHEA.parse().unwrap(),
            token: USDC.into(),
            max_alloc: U128(50 * UNIT),
            enabled: true,
            blocked_reason: None,
            extra_decimals: 12,
        },
    );
    v.set_max_move(USDC.into(), U128(20 * UNIT));
    v
}

#[test]
fn agent_can_supply_within_policy() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(10 * UNIT));
    assert_eq!(v.get_venues()[0].position.0, 10 * UNIT);
    assert_eq!(v.get_vault().moves_today, 1);
}

#[test]
#[should_panic(expected = "agent calls must come from the vault account's own key")]
fn outside_account_cannot_act_as_agent() {
    let mut v = setup();
    ctx("attacker.near", agent_pk(), 10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(UNIT));
}

#[test]
#[should_panic(expected = "signer is not the agent key")]
fn other_key_on_vault_cannot_act_as_agent() {
    let mut v = setup();
    ctx(VAULT, other_pk(), 10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(UNIT));
}

#[test]
#[should_panic(expected = "exceeds per-move cap")]
fn per_move_cap_holds() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(21 * UNIT));
}

#[test]
#[should_panic(expected = "would exceed venue cap")]
fn venue_allocation_cap_holds() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(20 * UNIT));
    as_agent(20_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(20 * UNIT));
    as_agent(30_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(20 * UNIT));
}

#[test]
#[should_panic(expected = "cooldown")]
fn cooldown_holds() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(UNIT));
    as_agent(10_100);
    let _ = v.agent_supply("rhea-usdc".into(), U128(UNIT));
}

#[test]
#[should_panic(expected = "daily move limit 3 reached")]
fn daily_limit_holds() {
    let mut v = setup();
    v.policy.cooldown_s = 0;
    for t in [90_000u64, 90_010, 90_020, 90_030] {
        as_agent(t);
        let _ = v.agent_supply("rhea-usdc".into(), U128(UNIT));
    }
}

#[test]
#[should_panic(expected = "unknown venue")]
fn agent_cannot_pick_an_unapproved_venue() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("attacker-pool".into(), U128(UNIT));
}

#[test]
#[should_panic(expected = "venue blocked: oracle single-source")]
fn blocked_venue_rejects_supply() {
    let mut v = setup();
    ctx(FEEDER, other_pk(), 5_000);
    v.block_venue("rhea-usdc".into(), "oracle single-source".into());
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(UNIT));
}

#[test]
fn blocked_venue_still_allows_withdraw() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(5 * UNIT));
    ctx(FEEDER, other_pk(), 10_050);
    v.block_venue("rhea-usdc".into(), "exploit reported".into());
    v.pause();
    as_agent(10_060); // inside the cooldown and paused: exit still works
    let _ = v.agent_withdraw("rhea-usdc".into(), U128(5 * UNIT));
}

#[test]
#[should_panic(expected = "owner only")]
fn feeder_cannot_unblock() {
    let mut v = setup();
    ctx(FEEDER, other_pk(), 5_000);
    v.block_venue("rhea-usdc".into(), "x".into());
    v.unblock_venue("rhea-usdc".into());
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_withdraw_to_itself() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.owner_withdraw(USDC.into(), U128(UNIT));
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_add_a_venue() {
    let mut v = setup();
    as_agent(10_000);
    v.add_venue(
        "evil".into(),
        Venue {
            kind: VenueKind::LendingFt,
            contract: "attacker.near".parse().unwrap(),
            token: USDC.into(),
            max_alloc: U128(u128::MAX),
            enabled: true,
            blocked_reason: None,
            extra_decimals: 12,
        },
    );
}

#[test]
#[should_panic(expected = "paused")]
fn pause_stops_supply() {
    let mut v = setup();
    ctx(FEEDER, other_pk(), 5_000);
    v.pause();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(UNIT));
}

#[test]
#[should_panic(expected = "owner only")]
fn feeder_cannot_unpause() {
    let mut v = setup();
    ctx(FEEDER, other_pk(), 5_000);
    v.pause();
    v.unpause();
}

#[test]
fn rhea_withdraw_amount_is_scaled_to_internal_units() {
    // 5 USDC (6 decimals) is 5e18 in Rhea Lend's internal 18-decimal units.
    assert_eq!(scale_up(5 * UNIT, 12), 5_000_000_000_000_000_000);
    assert_eq!(scale_up(7, 0), 7);
}
