//! NEARnest factory. Anyone creates their own vault in one call: the factory makes
//! `<name>.<factory>`, deploys the vault code, adds the agent's function-call key (and
//! no full-access key), and initializes the vault with the caller as owner and a preset
//! of venues and limits. The caller's deposit pays the vault's storage; the factory
//! keeps none of it.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PublicKey,
};

pub const VAULT_WASM: &[u8] = include_bytes!("../../contract/target/wasm32-unknown-unknown/release/nearnest_vault.wasm");
const GAS_INIT: Gas = Gas::from_tgas(100);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const AGENT_ALLOWANCE: NearToken = NearToken::from_millinear(500);
const AGENT_METHODS: &str = "agent_supply,agent_withdraw,agent_claim_unstaked";
/// On top of the code's storage: the vault's 0.5 NEAR reserve, storage registrations
/// and its own state.
const EXTRA: NearToken = NearToken::from_millinear(800);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Vaults,
    Refunds,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct VaultRecord {
    pub owner: AccountId,
    pub created_ns: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    owner: AccountId,
    agent_key: PublicKey,
    risk_feeder: Option<AccountId>,
    /// JSON for the vault's `new_preset` without owner, agent_key and risk_feeder:
    /// {"policy":..., "venues":[...], "max_moves":[...], "storage":[...]}
    preset: String,
    vaults: IterableMap<AccountId, VaultRecord>,
    refunds: LookupMap<AccountId, u128>,
}

/// Lowercase letters, digits and single dashes, 2 to 32 chars.
pub fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    (2..=32).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
        && !name.contains("--")
}

pub fn min_deposit() -> NearToken {
    env::storage_byte_cost().saturating_mul(VAULT_WASM.len() as u128).saturating_add(EXTRA)
}

#[near]
impl Factory {
    #[init]
    pub fn new(owner: AccountId, agent_key: PublicKey, risk_feeder: Option<AccountId>, preset: String) -> Self {
        Self::check_preset(&preset);
        Self {
            owner,
            agent_key,
            risk_feeder,
            preset,
            vaults: IterableMap::new(Key::Vaults),
            refunds: LookupMap::new(Key::Refunds),
        }
    }

    /// Create `<name>.<factory>` owned by the caller. Attach at least `get_min_deposit`.
    #[payable]
    pub fn create_vault(&mut self, name: String) -> Promise {
        require!(valid_name(&name), "name: 2 to 32 of a-z, 0-9 and single dashes");
        let deposit = env::attached_deposit();
        let min = min_deposit();
        if deposit < min {
            env::panic_str(&format!("attach at least {} yoctoNEAR", min.as_yoctonear()));
        }
        let owner = env::predecessor_account_id();
        let id: AccountId = format!("{name}.{}", env::current_account_id()).parse().unwrap();
        let mut args: Value = serde_json::from_str(&self.preset).unwrap();
        args["owner"] = json!(owner);
        args["agent_key"] = json!(self.agent_key);
        args["risk_feeder"] = json!(self.risk_feeder);
        Promise::new(id.clone())
            .create_account()
            .transfer(deposit)
            .deploy_contract(VAULT_WASM.to_vec())
            .add_access_key_allowance(
                self.agent_key.clone(),
                Allowance::limited(AGENT_ALLOWANCE).unwrap(),
                id.clone(),
                AGENT_METHODS,
            )
            .function_call("new_preset", args.to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_INIT)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_create(id, owner, U128(deposit.as_yoctonear())),
            )
    }

    /// Records the vault, or credits a refund if creation failed (for example, the name
    /// was taken). The refund is claimed with `claim_refund`, after NEAR has returned
    /// the deposit to the factory.
    #[private]
    pub fn on_create(&mut self, vault: AccountId, owner: AccountId, deposit: U128) -> bool {
        let ok = env::promise_result_checked(0, 64).is_ok();
        if ok {
            self.vaults.insert(vault.clone(), VaultRecord { owner: owner.clone(), created_ns: env::block_timestamp() });
            env::log_str(&format!("EVENT_JSON:{}", json!({"standard": "nearnest", "version": "1.0.0", "event": "vault_created", "data": [{"vault": vault, "owner": owner}]})));
        } else {
            let prev = self.refunds.get(&owner).copied().unwrap_or(0);
            self.refunds.insert(owner, prev + deposit.0);
        }
        ok
    }

    pub fn claim_refund(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.refunds.remove(&who).unwrap_or(0);
        require!(amount > 0, "nothing to refund");
        Promise::new(who).transfer(NearToken::from_yoctonear(amount))
    }

    // ---------------------------------------------------------------- owner

    pub fn set_preset(&mut self, preset: String) {
        self.assert_owner();
        Self::check_preset(&preset);
        self.preset = preset;
    }

    pub fn set_agent_key(&mut self, agent_key: PublicKey) {
        self.assert_owner();
        self.agent_key = agent_key;
    }

    pub fn set_risk_feeder(&mut self, risk_feeder: Option<AccountId>) {
        self.assert_owner();
        self.risk_feeder = risk_feeder;
    }

    // ---------------------------------------------------------------- views

    pub fn get_min_deposit(&self) -> U128 {
        U128(min_deposit().as_yoctonear())
    }

    pub fn get_config(&self) -> Value {
        json!({"owner": self.owner, "agent_key": self.agent_key, "risk_feeder": self.risk_feeder,
               "preset": serde_json::from_str::<Value>(&self.preset).unwrap(), "vault_code_bytes": VAULT_WASM.len(),
               "vault_code_sha256": hex(&env::sha256(VAULT_WASM))})
    }

    pub fn get_vaults(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, VaultRecord)> {
        self.vaults
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(100) as usize)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn vaults_of(&self, owner: AccountId) -> Vec<AccountId> {
        self.vaults.iter().filter(|(_, v)| v.owner == owner).map(|(k, _)| k.clone()).collect()
    }

    pub fn get_refund(&self, account_id: AccountId) -> U128 {
        U128(self.refunds.get(&account_id).copied().unwrap_or(0))
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn check_preset(preset: &str) {
        let v: Value = serde_json::from_str(preset).unwrap_or_else(|_| env::panic_str("preset must be JSON"));
        for k in ["policy", "venues", "max_moves", "storage"] {
            require!(v.get(k).is_some(), "preset needs policy, venues, max_moves and storage");
        }
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const PRESET: &str = r#"{"policy":{"cooldown_s":60,"max_moves_per_day":10},"venues":[],"max_moves":[],"storage":[]}"#;

    fn ctx(pred: &str, deposit: NearToken) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("factory.testnet".parse().unwrap())
            .predecessor_account_id(pred.parse().unwrap())
            .attached_deposit(deposit)
            .account_balance(NearToken::from_near(10));
        testing_env!(b.build());
    }
    fn factory() -> Factory {
        ctx("owner.testnet", NearToken::from_near(0));
        Factory::new(
            "owner.testnet".parse().unwrap(),
            "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap(),
            Some("risk.testnet".parse().unwrap()),
            PRESET.into(),
        )
    }

    #[test]
    fn names_are_checked() {
        assert!(valid_name("alice-vault"));
        assert!(valid_name("a1"));
        for bad in ["A", "a", "-ab", "ab-", "a--b", "a.b", "a_b", &"x".repeat(33)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn min_deposit_covers_the_vault_code() {
        let m = min_deposit().as_yoctonear();
        assert!(m >= VAULT_WASM.len() as u128 * 10u128.pow(19));
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn small_deposit_is_refused() {
        let mut f = factory();
        ctx("alice.testnet", NearToken::from_near(1));
        let _ = f.create_vault("alice".into());
    }

    #[test]
    fn create_vault_schedules_the_batch() {
        let mut f = factory();
        ctx("alice.testnet", NearToken::from_near(5));
        let _ = f.create_vault("alice".into());
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_owner_changes_the_preset() {
        let mut f = factory();
        ctx("alice.testnet", NearToken::from_near(0));
        f.set_preset(PRESET.into());
    }
}
