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
    assert_eq!(v.get_venues()[0].pending.0, 10 * UNIT);
    assert_eq!(v.get_venues()[0].position.0, 0);
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

// ------------------------------------------------- async settlement (callbacks)

fn as_callback(results: Vec<near_sdk::PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(VAULT.parse().unwrap())
        .predecessor_account_id(VAULT.parse().unwrap())
        .signer_account_id(VAULT.parse().unwrap())
        .account_balance(NearToken::from_near(10))
        .block_timestamp(5_000 * 1_000_000_000);
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), results);
}
fn burrow_answer(usdc_units: u128) -> Vec<u8> {
    format!(r#"{{"account_id":"v","supplied":[{{"token_id":"{USDC}","balance":"{}","shares":"1"}}],"collateral":[]}}"#, usdc_units * UNIT * 1_000_000_000_000).into_bytes()
}
fn ok(bytes: Vec<u8>) -> Vec<near_sdk::PromiseResult> {
    vec![near_sdk::PromiseResult::Successful(bytes)]
}

#[test]
fn venue_takes_the_supply_and_it_becomes_the_position() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(20 * UNIT));
    as_callback(ok(br#""20000000""#.to_vec()));
    assert_eq!(v.on_supply("rhea-usdc".into(), U128(20 * UNIT)).0, 20 * UNIT);
    let x = &v.get_venues()[0];
    assert_eq!((x.position.0, x.pending.0), (20 * UNIT, 0));
}

#[test]
fn refused_supply_releases_the_reservation() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(20 * UNIT));
    as_callback(vec![near_sdk::PromiseResult::Failed]);
    assert_eq!(v.on_supply("rhea-usdc".into(), U128(20 * UNIT)).0, 0);
    let x = &v.get_venues()[0];
    assert_eq!((x.position.0, x.pending.0), (0, 0));
}

#[test]
fn partly_used_supply_counts_only_what_the_venue_took() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(20 * UNIT));
    as_callback(ok(br#""5000000""#.to_vec()));
    v.on_supply("rhea-usdc".into(), U128(20 * UNIT));
    let x = &v.get_venues()[0];
    assert_eq!((x.position.0, x.pending.0), (5 * UNIT, 0));
}

/// The race Codex found: a venue read that left before the supply landed arrives after
/// it and reports the old balance. Before the fix it overwrote the reservation, so three
/// 20 USDC supplies fit under a 50 USDC cap.
#[test]
#[should_panic(expected = "would exceed venue cap")]
fn stale_sync_cannot_hide_an_in_flight_supply() {
    let mut v = setup();
    for (i, t) in [10_000u64, 20_000].iter().enumerate() {
        as_agent(*t);
        let _ = v.agent_supply("rhea-usdc".into(), U128(20 * UNIT));
        as_callback(ok(burrow_answer(0)));
        assert!(v.on_sync("rhea-usdc".into()));
        assert_eq!(v.get_venues()[0].pending.0, 20 * UNIT * (i as u128 + 1));
    }
    as_agent(30_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(20 * UNIT));
}

#[test]
fn sync_then_confirm_errs_toward_refusing() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(20 * UNIT));
    // The read lands after the venue took the deposit, then the confirmation arrives.
    as_callback(ok(burrow_answer(20)));
    v.on_sync("rhea-usdc".into());
    as_callback(ok(br#""20000000""#.to_vec()));
    v.on_supply("rhea-usdc".into(), U128(20 * UNIT));
    let x = &v.get_venues()[0];
    assert_eq!(x.pending.0, 0);
    assert!(x.position.0 >= 20 * UNIT, "never under the real holding");
    // The next read puts the books back on the venue's number.
    as_callback(ok(burrow_answer(20)));
    v.on_sync("rhea-usdc".into());
    assert_eq!(v.get_venues()[0].position.0, 20 * UNIT);
}

#[test]
fn failed_venue_read_changes_nothing() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(20 * UNIT));
    as_callback(vec![near_sdk::PromiseResult::Failed]);
    assert!(!v.on_sync("rhea-usdc".into()));
    let x = &v.get_venues()[0];
    assert_eq!((x.position.0, x.pending.0), (0, 20 * UNIT));
}

// ------------------------------------------------------------------- close

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_can_close() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.close();
}

#[test]
#[should_panic(expected = "still holds funds")]
fn close_refuses_while_a_venue_holds_funds() {
    let mut v = setup();
    as_agent(10_000);
    let _ = v.agent_supply("rhea-usdc".into(), U128(10 * UNIT));
    as_owner();
    let _ = v.close();
}

#[test]
fn close_reads_token_balances_first() {
    let mut v = setup();
    as_owner();
    let _ = v.close();
    // One read per FT token, then the callback; nothing is deleted yet.
    assert!(!near_sdk::test_utils::get_created_receipts().is_empty());
}

#[test]
#[should_panic(expected = "the vault still holds tokens")]
fn close_refuses_while_the_vault_holds_tokens() {
    let mut v = setup();
    as_callback(ok(br#""5""#.to_vec()));
    let _ = v.on_close(1);
}

#[test]
fn close_deletes_the_vault_when_everything_is_empty() {
    let mut v = setup();
    as_callback(ok(br#""0""#.to_vec()));
    let _ = v.on_close(1);
    assert!(near_sdk::test_utils::get_logs().iter().any(|l| l.contains("vault_closed")));
}
