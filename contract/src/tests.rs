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

// ------------------------------------------------------------------ v3

#[test]
fn feeder_can_lower_the_risk_cap() {
    let mut v = setup();
    ctx(FEEDER, other_pk(), 5_000);
    v.set_risk_cap("rhea-usdc".into(), U128(25 * UNIT));
    let view = v.get_venues().into_iter().find(|x| x.id == "rhea-usdc").unwrap();
    assert_eq!(view.effective_cap.0, 25 * UNIT);
    assert_eq!(view.risk_cap.unwrap().0, 25 * UNIT);
}

#[test]
#[should_panic(expected = "risk feeder can only lower the cap")]
fn feeder_cannot_raise_the_risk_cap() {
    let mut v = setup();
    ctx(FEEDER, other_pk(), 5_000);
    v.set_risk_cap("rhea-usdc".into(), U128(25 * UNIT));
    v.set_risk_cap("rhea-usdc".into(), U128(40 * UNIT));
}

#[test]
#[should_panic(expected = "owner only")]
fn feeder_cannot_clear_the_risk_cap() {
    let mut v = setup();
    ctx(FEEDER, other_pk(), 5_000);
    v.set_risk_cap("rhea-usdc".into(), U128(25 * UNIT));
    v.clear_risk_cap("rhea-usdc".into());
}

#[test]
#[should_panic(expected = "would exceed risk cap")]
fn stolen_key_is_held_to_the_risk_cap() {
    let mut v = setup();
    ctx(FEEDER, other_pk(), 5_000);
    v.set_risk_cap("rhea-usdc".into(), U128(10 * UNIT));
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(15 * UNIT));
}

#[test]
fn owner_can_raise_and_clear_the_risk_cap() {
    let mut v = setup();
    ctx(FEEDER, other_pk(), 5_000);
    v.set_risk_cap("rhea-usdc".into(), U128(10 * UNIT));
    as_owner();
    v.set_risk_cap("rhea-usdc".into(), U128(30 * UNIT));
    v.clear_risk_cap("rhea-usdc".into());
    let view = v.get_venues().into_iter().find(|x| x.id == "rhea-usdc").unwrap();
    assert_eq!(view.effective_cap.0, 50 * UNIT);
    assert!(view.risk_cap.is_none());
}

#[test]
fn guardians_can_exit_without_the_agent() {
    let mut v = setup();
    ctx(FEEDER, other_pk(), 5_000);
    let _ = v.guardian_exit("rhea-usdc".into(), U128(UNIT));
    as_owner();
    let _ = v.guardian_exit("rhea-usdc".into(), U128(UNIT));
}

#[test]
#[should_panic(expected = "owner or risk feeder only")]
fn outsiders_cannot_use_guardian_exit() {
    let mut v = setup();
    ctx("attacker.near", other_pk(), 5_000);
    let _ = v.guardian_exit("rhea-usdc".into(), U128(UNIT));
}

#[test]
fn venue_account_answers_parse_into_positions() {
    let burrow = br#"{"account_id":"v","supplied":[{"token_id":"dai.fakes.testnet","balance":"7"},{"token_id":"usdc.fakes.testnet","balance":"25000656535604415719","shares":"1"}],"collateral":[]}"#;
    assert_eq!(parse_venue_account(&VenueKind::LendingFt, "usdc.fakes.testnet", 12, burrow), Some((25_000_656, 0)));
    assert_eq!(parse_venue_account(&VenueKind::LendingFt, "usdt.near", 12, burrow), Some((0, 0)));
    assert_eq!(parse_venue_account(&VenueKind::LendingFt, "usdc.fakes.testnet", 12, b"null"), Some((0, 0)));
    let linear = br#"{"account_id":"v","unstaked_balance":"400","staked_balance":"600","can_withdraw":false}"#;
    assert_eq!(parse_venue_account(&VenueKind::LiquidStake, "near", 0, linear), Some((600, 400)));
    assert_eq!(parse_venue_account(&VenueKind::LiquidStake, "near", 0, b"{\"oops\":1}"), None);
}

#[test]
#[should_panic(expected = "would exceed venue cap")]
fn unbonding_counts_toward_the_venue_cap() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(20 * UNIT));
    raw_set("unb", "rhea-usdc", Some(25 * UNIT));
    as_agent(20_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(10 * UNIT));
}

#[test]
fn preset_init_sets_venues_caps_and_feeder() {
    as_owner();
    let v = Vault::new_preset(
        OWNER.parse().unwrap(),
        agent_pk(),
        Policy { cooldown_s: 60, max_moves_per_day: 10 },
        Some(FEEDER.parse().unwrap()),
        vec![(
            "burrow-usdc".into(),
            Venue { kind: VenueKind::LendingFt, contract: RHEA.parse().unwrap(), token: USDC.into(), max_alloc: U128(50 * UNIT), enabled: true, blocked_reason: None, extra_decimals: 12 },
        )],
        vec![(USDC.into(), U128(20 * UNIT))],
        vec![(USDC.parse().unwrap(), U128(1))],
    );
    assert_eq!(v.get_vault().risk_feeder.unwrap().as_str(), FEEDER);
    let venues = v.get_venues();
    assert_eq!(venues.len(), 1);
    assert_eq!(venues[0].max_move.0, 20 * UNIT);
}
