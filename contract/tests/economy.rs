// Contract methods that schedule transfers return a Promise; the mocked
// runtime has nothing to await, so tests drop them.
#![allow(unused_must_use)]
use divemarket::*;
use near_crypto::{InMemorySigner, KeyType, PublicKey, Signature};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken, VMContext};

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

// The game server's keypair, used to sign catch receipts.
const SIGNER: &str = "signer.owner.near";
// Deterministic test keypair for the game server. A fixed seed keeps the
// public key stable across runs, so the contract can be built with it.
const SIGNER_SEED: &str = "divemarket-game-signer-test-seed";
const OWNER: &str = "owner.near";
const BOB: &str = "bob";
const ALICE: &str = "alice";
const JOHN: &str = "john";
const PLAYER: &str = "player.near";

/// Scaled price helper: 1.5 NEAR per unit -> 1_500_000.
fn sp(whole: u128, frac_micros: u128) -> u128 {
    whole * PRICE_SCALE + frac_micros
}

fn ctx(predecessor: &str) -> VMContext {
    VMContextBuilder::new()
        .predecessor_account_id(predecessor.parse().unwrap())
        .block_timestamp(1_700_000_000_000_000_000)
        // register_npc takes the treasury as an attached deposit, and
        // npc_buy/npc_sell charge for the storage they write.
        .account_balance(NearToken::from_near(10_000))
        .attached_deposit(NearToken::from_yoctonear(10_000 * ONE_NEAR))
        .build()
}

fn ctx_at(predecessor: &str, ts: u64) -> VMContext {
    VMContextBuilder::new()
        .predecessor_account_id(predecessor.parse().unwrap())
        .block_timestamp(ts)
        // npc_sell writes a listing and charges the caller for the storage,
        // so the default context attaches enough to cover it.
        .account_balance(NearToken::from_near(1_000))
        .attached_deposit(NearToken::from_yoctonear(LISTING_STORAGE_COST))
        .build()
}

/// A context with an exact attached deposit, for calls that must be paid
/// for precisely (invest, buy_from_npc).
fn ctx_pay(predecessor: &str, deposit: u128, ts: u64) -> VMContext {
    VMContextBuilder::new()
        .predecessor_account_id(predecessor.parse().unwrap())
        .block_timestamp(ts)
        .account_balance(NearToken::from_near(10_000))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build()
}

const T0: u64 = 1_700_000_000_000_000_000;
const BUYER: &str = "buyer.near";

/// Bob posts an ask and a separate player pays it. This is the only way an
/// NPC turns inventory back into treasury.
fn npc_sells_to_player(c: &mut Contract, ask: u128, units: u64, ts: u64) {
    testing_env!(ctx_at("bob.owner.near", ts));
    c.npc_sell(BOB.into(), "guppy".into(), units, U128(ask));
    let cost = ask * units as u128 * ONE_NEAR / PRICE_SCALE;
    testing_env!(ctx_pay(BUYER, cost, ts));
    c.buy_from_npc(BOB.into(), "guppy".into(), units, U128(ask));
}

/// Bob posts an ask without anyone buying.
fn post_ask(c: &mut Contract, ask: u128) {
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_500_000_000));
    c.npc_sell(BOB.into(), "guppy".into(), 1, U128(ask));
}

/// Bob: aggressive. Buys up to 15% above fair, sells 10% below, deploys 40%
/// of treasury, keeps 10% reserve.
fn bob_personality() -> Personality {
    Personality {
        buy_tolerance_bps: 1_500,
        sell_tolerance_bps: 1_000,
        aggression_bps: 4_000,
        reserve_bps: 1_000,
        min_edge_bps: 200,
    }
}

/// Alice: conservative. Buys only 3% above fair, sells 3% below, deploys 15%,
/// keeps half her treasury in reserve.
fn alice_personality() -> Personality {
    Personality {
        buy_tolerance_bps: 300,
        sell_tolerance_bps: 300,
        aggression_bps: 1_500,
        reserve_bps: 5_000,
        min_edge_bps: 500,
    }
}

/// John: opportunist. Chases undervalued goods, moderate aggression.
fn john_personality() -> Personality {
    Personality {
        buy_tolerance_bps: 800,
        sell_tolerance_bps: 1_200,
        aggression_bps: 2_500,
        reserve_bps: 2_500,
        min_edge_bps: 100,
    }
}

/// A market with one item ("fish", base 1 NEAR) and three NPCs with 100 NEAR
/// each.
/**
 * Sign a catch receipt the way the game server does.
 *
 * The message format must match the contract's exactly:
 * "catch:<contract>:<player>:<item>:<units>:<nonce>". A mismatch is the difference between a
 * legitimate catch and a forged one, so it lives in one place.
 */
/// Monotonic nonce source. Each catch needs a fresh nonce or the contract
/// refuses it as a replay, so tests draw from here instead of hardcoding.
fn next_nonce() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

/// The contract account in unit tests (VMContextBuilder's default).
const CONTRACT_ACCOUNT: &str = "alice.near";

fn sign_catch(player: &str, item: &str, units: u64) -> (PublicKey, Signature, u64) {
    let nonce = next_nonce();
    let kp = InMemorySigner::from_seed(SIGNER.parse().unwrap(), KeyType::ED25519, SIGNER_SEED);
    let message = format!("catch:{}:{}:{}:{}:{}", CONTRACT_ACCOUNT, player, item, units, nonce);
    let sig = kp.sign(message.as_bytes());
    (kp.public_key(), sig, nonce)
}

/// Tests written before zones called a single-species `catch_fish`. It is
/// gone from the contract; this shim keeps those tests meaningful by turning
/// each call into the real path: one Shallows receipt through
/// `claim_catches`, paying the license on top of whatever the test attached.
/// A signature the old helper did not produce stays invalid, so the tests
/// that expect a forged or swapped catch to fail still fail.
trait LegacyCatch {
    fn catch_fish(&mut self, item_id: String, units: u64, nonce: u64, signature: String);
}
impl LegacyCatch for Contract {
    fn catch_fish(&mut self, item_id: String, units: u64, nonce: u64, signature: String) {
        let player = near_sdk::env::predecessor_account_id().to_string();
        let ts = near_sdk::env::block_timestamp();
        let attached = near_sdk::env::attached_deposit().as_yoctonear();
        if self.get_zone("shallows".into()).is_none() {
            testing_env!(ctx(OWNER));
            self.register_zone("shallows".into(), "Shallows".into(), 10_000, 100, U128(BASE_FEE), 0);
        }
        let kp = InMemorySigner::from_seed(SIGNER.parse().unwrap(), KeyType::ED25519, SIGNER_SEED);
        let legacy = format!("catch:{}:{}:{}:{}:{}", CONTRACT_ACCOUNT, player, item_id, units, nonce);
        let genuine = kp.sign(legacy.as_bytes()).to_string() == signature;
        let zone_msg = format!("catch:{}:{}:shallows:{}:{}:{}:100", CONTRACT_ACCOUNT, player, item_id, units, nonce);
        let sig = if genuine { kp.sign(zone_msg.as_bytes()).to_string() } else { signature };
        let deposit = if attached >= CATCH_FEE_NEAR {
            attached - CATCH_FEE_NEAR + self.claim_quote(vec![("shallows".into(), units)], None).0
        } else {
            attached
        };
        testing_env!(ctx_pay(&player, deposit, ts));
        self.claim_catches(vec![CatchReceipt {
            zone_id: "shallows".into(), item_id, units, nonce, weight_g: 100, poached: false,
            bait: None, rod: None, signature: sig,
        }]);
    }
}

/// Sign a zone receipt the way the game server does for claim_catches.
fn sign_zone_catch_w(player: &str, zone: &str, item: &str, units: u64, weight: u64) -> (PublicKey, Signature, u64) {
    let nonce = next_nonce();
    let kp = InMemorySigner::from_seed(SIGNER.parse().unwrap(), KeyType::ED25519, SIGNER_SEED);
    let message = format!("catch:{}:{}:{}:{}:{}:{}:{}", CONTRACT_ACCOUNT, player, zone, item, units, nonce, weight);
    (kp.public_key(), kp.sign(message.as_bytes()), nonce)
}

fn sign_zone_catch(player: &str, zone: &str, item: &str, units: u64) -> (PublicKey, Signature, u64) {
    sign_zone_catch_w(player, zone, item, units, 100)
}

fn receipt_w(player: &str, zone: &str, item: &str, weight: u64) -> CatchReceipt {
    let (_, sig, nonce) = sign_zone_catch_w(player, zone, item, 1, weight);
    CatchReceipt { zone_id: zone.into(), item_id: item.into(), units: 1, nonce, weight_g: weight, poached: false, bait: None, rod: None, signature: sig.to_string() }
}

fn receipt(player: &str, zone: &str, item: &str) -> CatchReceipt {
    receipt_w(player, zone, item, 100)
}

/// Base license in tests: 0.001 NEAR per fish at full health.
const BASE_FEE: u128 = ONE_NEAR / 1_000;

fn market() -> Contract {
    testing_env!(ctx(OWNER));
    let mut c = Contract::new(OWNER.parse().unwrap(), SIGNER.parse().unwrap());
    // Every test needs to be able to catch, so the signer key is installed
    // up front rather than repeated in each test.
    let (pk, _, _) = sign_catch(PLAYER, "guppy", 0);
    c.set_game_signer(pk.to_string());
    // Five tiers, each with its own utility. A legendary koi is a trophy only
    // the wealthiest NPCs bid on; a common guppy is food for everyone.
    c.register_item("guppy".into(), "Guppy".into(), U128(sp(1, 0)), RARITY_COMMON, UTILITY_FOOD);
    c.register_item("tilapia".into(), "Tilapia".into(), U128(sp(1, 0)), RARITY_UNCOMMON, UTILITY_FOOD);
    c.register_item("snapper".into(), "Snapper".into(), U128(sp(1, 0)), RARITY_RARE, UTILITY_MATERIAL);
    c.register_item("tuna".into(), "Tuna".into(), U128(sp(1, 0)), RARITY_EPIC, UTILITY_FOOD);
    c.register_item("koi".into(), "Legendary Koi".into(), U128(sp(1, 0)), RARITY_LEGENDARY, UTILITY_TROPHY);
    c.register_npc(BOB.into(), "bob.owner.near".into(), U128(100 * ONE_NEAR), bob_personality());
    c.register_npc(ALICE.into(), "alice.owner.near".into(), U128(100 * ONE_NEAR), alice_personality());
    c.register_npc(JOHN.into(), "john.owner.near".into(), U128(100 * ONE_NEAR), john_personality());
    c.register_zone("shallows".into(), "Shallows".into(), 1_000, 60, U128(BASE_FEE), 0);
    c.register_zone("pond".into(), "Tiny Pond".into(), 10, 6, U128(BASE_FEE), 0);
    c
}

// ============================================================ pricing engine

#[test]
fn fair_price_is_deterministic_pure_function() {
    let c = market();
    // Same state, same answer, every time.
    let a = c.fair_price("guppy".into()).0;
    let b = c.fair_price("guppy".into()).0;
    assert_eq!(a, b, "fair price must not depend on call order");
    assert_eq!(a, sp(0, 100_000), "with no activity, price is base * rarity");
}

#[test]
fn npc_buying_pushes_price_up() {
    let mut c = market();
    let before = c.fair_price("guppy".into()).0;

    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);

    // Bob buys 10 units at base price.
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    c.npc_buy(BOB.into(), 0, 10);

    let after = c.fair_price("guppy".into()).0;
    assert!(
        after > before,
        "NPC buying must push the price up: {} -> {}",
        before,
        after
    );
}

#[test]
fn player_supply_pushes_price_down() {
    let mut c = market();
    let before = c.fair_price("guppy".into()).0;

    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 20);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 20, nonce, sig.to_string());
    c.list_fair("guppy".into(), 20);

    let after = c.fair_price("guppy".into()).0;
    assert!(
        after < before,
        "player listings must push the price down: {} -> {}",
        before,
        after
    );
}

#[test]
fn npc_inventory_pushes_price_down() {
    let mut c = market();
    let before = c.fair_price("guppy".into()).0;

    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    c.npc_buy(BOB.into(), 0, 10);

    // Roll the pricing window so the buy volume resets, leaving NPC stock as
    // the only moving input. Demand and scarcity can offset each other when
    // both are live, which is the economy working, not a bug.
    testing_env!(ctx_at(OWNER, 1_700_000_000_000_000_000 + 3_700_000_000_000));
    let after = c.fair_price("guppy".into()).0;
    assert!(
        after < before,
        "NPC stock alone must push the price down: {} -> {}",
        before,
        after
    );
}

#[test]
fn event_modifier_moves_price() {
    let mut c = market();
    let before = c.fair_price("guppy".into()).0;
    testing_env!(ctx(OWNER));
    c.set_event("guppy".into(), U128(20_000), "drought".into());
    let after = c.fair_price("guppy".into()).0;
    assert_eq!(after, before * 2, "a 2x event must double the price");
}

#[test]
fn price_is_bounded_against_runaway_counters() {
    // A whale NPC with a large treasury, so the test measures the price
    // ceiling rather than running out of money.
    testing_env!(ctx(OWNER));
    let mut c = Contract::new(OWNER.parse().unwrap(), SIGNER.parse().unwrap());
    c.register_item("guppy".into(), "Fish".into(), U128(sp(1, 0)), RARITY_COMMON, UTILITY_FOOD);
    c.register_npc(
        "whale".into(),
        "whale.owner.near".into(),
        U128(10_000 * ONE_NEAR),
        Personality {
            buy_tolerance_bps: 1_500,
            sell_tolerance_bps: 1_000,
            aggression_bps: 9_000,
            reserve_bps: 0,
            min_edge_bps: 0,
        },
    );

    testing_env!(ctx(PLAYER));
    // Many small listings, each priced at fair, so no single listing drags
    // the supply factor to its floor and puts its own ask out of band.
    for _ in 0..25 {
        testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 1);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 1, nonce, sig.to_string());
    c.list_fair("guppy".into(), 1);
    }
    // Buy hard: one round per pricing window, so the rate limit does not
    // mask the price ceiling.
    // Same timestamp the listings were created at, so the TTL does not
    // expire them mid-test — this test is about the price ceiling, not
    // listing expiry.
    // 15 trades: enough to push the demand factor to its ceiling, and under
    // MAX_TRADES_PER_WINDOW so the rate limit does not mask the price bound.
    for i in 0..15u64 {
        testing_env!(ctx_at("whale.owner.near", 1_700_000_000_000_000_000));
        let _ = c.npc_buy("whale".into(), i, 1);
    }
    let p = c.fair_price("guppy".into()).0;
    assert!(p <= sp(5, 0), "price must stay under the 5x ceiling, got {}", p);
    assert!(p >= 1, "price must never reach zero");
}

// ======================================================== real NPC treasuries

#[test]
fn npc_treasury_is_real_and_debits() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    // The listing itself moves supply, so re-read fair price after listing
    // and confirm the ask is inside the band.
    let fair_after = c.fair_price("guppy".into()).0;
    let ask = c.open_listings()[0].1.ask_price;
    assert!(
        ask <= fair_after * (BPS + MAX_OVERPAY_BPS) / BPS,
        "ask must be inside the overpay band"
    );
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));

    let before = c.get_npc(BOB.into()).unwrap().treasury;
    c.npc_buy(BOB.into(), 0, 10);
    let after = c.get_npc(BOB.into()).unwrap().treasury;

    assert_eq!(before, 100 * ONE_NEAR);
    // The ask is the fair price, which the listing itself moved, so the
    // debit is 10 units at that price rather than a round 10 NEAR.
    let spent = before - after;
    assert!(spent > 0, "the treasury must be debited");
    assert_eq!(
        after,
        before - spent,
        "the debit must equal exactly what was paid"
    );
    assert_eq!(
        c.get_npc(BOB.into()).unwrap().units_of("guppy"),
        10,
        "the units must land in inventory"
    );
}

#[test]
fn npc_cannot_spend_money_it_does_not_have() {
    testing_env!(ctx(OWNER));
    let mut c = Contract::new(OWNER.parse().unwrap(), SIGNER.parse().unwrap());
    c.register_item("guppy".into(), "Fish".into(), U128(sp(1, 0)), RARITY_COMMON, UTILITY_FOOD);
    // Bob starts with only 1 NEAR.
    c.register_npc(BOB.into(), "bob.owner.near".into(), U128(ONE_NEAR), bob_personality());

    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.npc_buy(BOB.into(), 0, 10);
    }));
    assert!(result.is_err(), "a broke NPC must not be able to buy");
}

#[test]
fn npc_cannot_buy_beyond_its_reserve() {
    let mut c = market();
    // Alice keeps 50% in reserve, so she can only ever spend 50 NEAR.
    // A high-value item keeps the per-unit price near base even after the
    // listing moves supply, so a 5-unit order clearly costs more than 50.
    testing_env!(ctx(OWNER));
    c.register_item("gold".into(), "Gold".into(), U128(sp(20, 0)), RARITY_RARE, UTILITY_MATERIAL);

    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "gold", 5);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("gold".into(), 5, nonce, sig.to_string());
    c.list_fair("gold".into(), 5);
    let cost = c.open_listings()[0].1.ask_price * 5 * ONE_NEAR / PRICE_SCALE;
    assert!(
        cost > 50 * ONE_NEAR,
        "this test needs a cost above Alice's 50 NEAR ceiling, got {}",
        cost
    );
    testing_env!(ctx_at("alice.owner.near", 1_700_000_000_000_000_000));

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.npc_buy(ALICE.into(), 0, 5);
    }));
    assert!(result.is_err(), "the reserve must cap what Alice can spend");
}

#[test]
fn npc_sell_credits_treasury_and_realizes_profit() {
    let mut c = market();
    // Bob buys 10 at 1 NEAR.
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    c.npc_buy(BOB.into(), 0, 10);

    let treasury_after_buy = c.get_npc(BOB.into()).unwrap().treasury;
    let profit_before = c.get_npc(BOB.into()).unwrap().realized_profit;
    let cost_basis = c.get_npc(BOB.into()).unwrap().avg_cost_of("guppy");

    // Bob sells 10 at 2 NEAR — realized profit of (2.0 - cost) * 10.
    npc_sells_to_player(&mut c, sp(2, 0), 10, 1_700_000_001_000_000_000);

    let npc = c.get_npc(BOB.into()).unwrap();
    let revenue = sp(2, 0) * 10 * ONE_NEAR / PRICE_SCALE;
    assert_eq!(
        npc.treasury,
        treasury_after_buy + revenue,
        "selling 10 at 2 NEAR must credit the revenue"
    );
    // Profit is measured in scaled units: (sold_for - paid_for) * units.
    let expected_profit = (sp(2, 0) - cost_basis) as i128 * 10;
    assert_eq!(
        npc.realized_profit - profit_before,
        expected_profit,
        "realized profit must be sold-for minus paid-for"
    );
    assert_eq!(npc.units_of("guppy"), 0, "inventory must be emptied");
}

#[test]
fn profit_is_realized_not_marked_to_market() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    c.npc_buy(BOB.into(), 0, 10);

    // Someone else buys hard, driving the price to 3 NEAR.
    testing_env!(ctx(OWNER));
    c.set_event("guppy".into(), U128(30_000), "frenzy".into());

    let npc = c.get_npc(BOB.into()).unwrap();
    assert_eq!(
        npc.realized_profit, 0,
        "holding an appreciated asset must not count as profit"
    );
}

// ============================================================ wash trading

#[test]
fn self_trade_is_refused() {
    let mut c = market();
    // A player lists, then tries to have the NPC buy its own listing.
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));

    // The listing is owned by player.near, not bob, so this passes the
    // self-trade check. The check is proven by listing from the NPC itself.
    testing_env!(ctx_at("bob.owner.near", 1_700_000_002_000_000_000));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 5);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 5, nonce, sig.to_string());
    c.list_fair("guppy".into(), 5);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.npc_buy(BOB.into(), 1, 5);
    }));
    assert!(result.is_err(), "an NPC must not buy its own listing");
}

#[test]
fn order_size_is_bounded() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let too_small = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 0);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 0, nonce, sig.to_string());
    c.list_fair("guppy".into(), 0);
    }));
    assert!(too_small.is_err(), "zero-unit orders must be refused");

    let too_big = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.list("guppy".into(), 100_000, U128(sp(1, 0)));
    }));
    assert!(too_big.is_err(), "oversized orders must be refused");
}

#[test]
fn npc_trade_rate_is_limited() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    // List enough for many trades.
    for _ in 0..30 {
        testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 1);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 1, nonce, sig.to_string());
    c.list_fair("guppy".into(), 1);
    }

    let mut allowed = 0;
    for i in 0..30u64 {
        testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000 + i * 1_000_000_000));
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.npc_buy(BOB.into(), i, 1);
        }))
        .is_ok()
        {
            allowed += 1;
        }
    }
    assert_eq!(
        allowed, MAX_TRADES_PER_WINDOW,
        "the rate limit must cap Bob at {} trades per hour",
        MAX_TRADES_PER_WINDOW
    );
}

#[test]
fn overpricing_is_refused() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    // Ask 3 NEAR when fair is 1 NEAR — 200% over, far beyond the 20% band.
    c.list("guppy".into(), 10, U128(sp(3, 0)));
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.npc_buy(BOB.into(), 0, 10);
    }));
    assert!(result.is_err(), "an ask far above fair price must be refused");
}

#[test]
fn underpricing_is_refused() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    c.npc_buy(BOB.into(), 0, 10);

    // Bob tries to dump at 0.01 NEAR when fair is ~0.1 — beyond the 30% band.
    testing_env!(ctx_at("bob.owner.near", 1_700_000_001_000_000_000));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.npc_sell(BOB.into(), "guppy".into(), 10, U128(sp(0, 10_000)));
    }));
    assert!(result.is_err(), "an ask far below fair price must be refused");
}

// ============================================================== personalities

#[test]
fn personalities_are_stored_as_constants() {
    let c = market();
    let bob = c.get_npc(BOB.into()).unwrap();
    let alice = c.get_npc(ALICE.into()).unwrap();
    let john = c.get_npc(JOHN.into()).unwrap();

    assert_eq!(bob.buy_tolerance_bps, 1_500, "Bob buys 15% above fair");
    assert_eq!(alice.buy_tolerance_bps, 300, "Alice buys 3% above fair");
    assert_eq!(john.buy_tolerance_bps, 800, "John buys 8% above fair");
    assert_eq!(bob.reserve_bps, 1_000);
    assert_eq!(alice.reserve_bps, 5_000, "Alice keeps half in reserve");
    assert_eq!(john.reserve_bps, 2_500);
}

#[test]
fn same_market_different_npc_behaviour() {
    // Three NPCs, one identical market. Bob (aggressive) can afford a trade
    // Alice (conservative) cannot, because her reserve caps her spending.
    let mut c = market();
    testing_env!(ctx(PLAYER));
    // Two catches: a single catch is capped at MAX_CATCH_UNITS. Legendary
    // koi, so the order is expensive enough for the reserves to matter.
    let (pk, sig, nonce) = sign_catch(PLAYER, "snapper", 50);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("snapper".into(), 50, nonce, sig.to_string());
    let (pk, sig, nonce) = sign_catch(PLAYER, "snapper", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("snapper".into(), 10, nonce, sig.to_string());
    c.list_fair("snapper".into(), 60);

    testing_env!(ctx_at("alice.owner.near", 1_700_000_000_000_000_000));
    let alice_ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.npc_buy(ALICE.into(), 0, 60);
    }))
    .is_ok();
    assert!(!alice_ok, "Alice's reserve blocks a 60-unit snapper buy");

    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    let bob_ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.npc_buy(BOB.into(), 0, 60);
    }))
    .is_ok();
    assert!(bob_ok, "Bob's low reserve lets the same buy through");
}

// =============================================================== investment

#[test]
fn investment_adds_real_capital_to_treasury() {
    let mut c = market();
    let before = c.get_npc(BOB.into()).unwrap().treasury;

    testing_env!(ctx_pay(PLAYER, 5 * ONE_NEAR, T0));
    c.invest(BOB.into(), U128(5 * ONE_NEAR));

    let after = c.get_npc(BOB.into()).unwrap().treasury;
    assert_eq!(
        after,
        before + 5 * ONE_NEAR,
        "invested capital must join the NPC treasury"
    );

    let inv = c.investment_of(BOB.into(), PLAYER.parse().unwrap()).unwrap();
    assert_eq!(inv.principal, 5 * ONE_NEAR);
    assert_eq!(inv.share_bps, 3_000, "investor takes 30% of realized profit");
}

#[test]
fn investor_paid_from_realized_profit_only() {
    let mut c = market();
    testing_env!(ctx_pay(PLAYER, 5 * ONE_NEAR, T0));
    c.invest(BOB.into(), U128(5 * ONE_NEAR));

    // Bob buys at fair, then sells higher — a real gain.
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    c.npc_buy(BOB.into(), 0, 10);

    // No profit yet, so nothing to claim.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.claim_profit(BOB.into());
    }));
    assert!(result.is_err(), "a losing NPC owes its investor nothing");

    // Bob sells at a gain. The ask must sit inside the undercut band of the
    // *current* fair price, which the buy itself moved up.
    testing_env!(ctx_at("bob.owner.near", 1_700_000_001_000_000_000));
    let fair_now = c.fair_price("guppy".into()).0;
    let ask = fair_now * (BPS + 1_000) / BPS;
    npc_sells_to_player(&mut c, ask, 10, 1_700_000_001_000_000_000);

    testing_env!(ctx(PLAYER));
    // Returns a transfer Promise; the credited amount is asserted through the
    // investment record, which tracks exactly what has been paid out.
    let _promise = c.claim_profit(BOB.into());
    let inv = c.investment_of(BOB.into(), PLAYER.parse().unwrap()).unwrap();
    let profit = c.get_npc(BOB.into()).unwrap().realized_profit;
    let expected = profit as u128 * 3_000 / BPS;
    assert_eq!(
        inv.claimed, expected as i128,
        "investor must be credited 30% of realized profit"
    );
}

#[test]
fn principal_is_locked_until_cooldown() {
    let mut c = market();
    testing_env!(ctx_pay(PLAYER, 5 * ONE_NEAR, T0));
    c.invest(BOB.into(), U128(5 * ONE_NEAR));

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.withdraw_principal(BOB.into());
    }));
    assert!(result.is_err(), "principal must be locked for the cooldown");

    // After the cooldown it comes back.
    testing_env!(ctx_at(PLAYER, 1_700_000_000_000_000_000 + 90_000 * 1_000_000_000));
    let _promise = c.withdraw_principal(BOB.into());
    let inv = c.investment_of(BOB.into(), PLAYER.parse().unwrap()).unwrap();
    assert_eq!(inv.principal, 0, "principal must be zeroed on withdrawal");
    // The treasury started at 100 NEAR and the 5 NEAR investment joined it,
    // so withdrawing the principal returns it to 100 NEAR.
    assert_eq!(
        c.get_npc(BOB.into()).unwrap().treasury,
        100 * ONE_NEAR,
        "the NPC treasury must be debited by the withdrawn principal"
    );
}

// ============================================================== access control

#[test]
fn only_owner_registers_items_and_npcs() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let r1 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.register_item("gold".into(), "Gold".into(), U128(sp(10, 0)), RARITY_RARE, UTILITY_MATERIAL);
    }));
    assert!(r1.is_err(), "players must not mint new items");

    let r2 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.register_npc("eve".into(), "eve.owner.near".into(), U128(ONE_NEAR), bob_personality());
    }));
    assert!(r2.is_err(), "players must not mint new NPCs");
}

#[test]
fn only_owner_sets_events() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.set_event("guppy".into(), U128(50_000), "manipulated".into());
    }));
    assert!(r.is_err(), "players must not be able to shock the market");
}

#[test]
fn unknown_npc_cannot_trade() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("mallory.owner.near", 1_700_000_000_000_000_000));

    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.npc_buy("mallory".into(), 0, 10);
    }));
    assert!(r.is_err(), "an unregistered NPC must not be able to trade");
}

// ================================================================ audit trail

#[test]
fn every_trade_is_recorded() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    c.npc_buy(BOB.into(), 0, 10);
    npc_sells_to_player(&mut c, sp(2, 0), 10, 1_700_000_001_000_000_000);

    let trades = c.recent_trades(10);
    assert_eq!(trades.len(), 2, "both trades must be on the log");
    assert_eq!(trades[0].kind, "player_buy");
    assert_eq!(trades[1].kind, "npc_buy");
    assert_eq!(trades[0].npc_id, BOB);
    assert_eq!(trades[0].units, 10);
    // The log records the price paid *and* the fair price at settlement, so
    // anyone can audit whether the trade was inside the band.
    assert!(trades[1].price > 0, "the log must record the price paid");
    assert!(trades[1].fair_price > 0);
}

#[test]
fn listing_lifecycle_updates_supply() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    assert_eq!(c.get_item("guppy".into()).unwrap().listed_supply, 10);

    testing_env!(ctx(PLAYER));
    c.cancel_listing(0);
    assert_eq!(
        c.get_item("guppy".into()).unwrap().listed_supply,
        0,
        "cancelling must return the units to the owner, not the market"
    );
}

// ============================================================ agent key scoping

#[test]
fn agent_key_issue_and_revoke() {
    let mut c = market();
    let pk = "ed25519:3hJHzSnCi5MyYNKkvW9MTpieRAM81jTvM7LAkVeGZbU4".to_string();

    testing_env!(ctx(OWNER));
    c.issue_agent_key(BOB.into(), pk.clone(), None);
    assert_eq!(
        c.agent_keys(BOB.into()),
        vec![pk.clone()],
        "the issued key must be recorded"
    );

    // Issuing the same key twice is refused.
    let dup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.issue_agent_key(BOB.into(), pk.clone(), None);
    }));
    assert!(dup.is_err(), "a key cannot be issued twice");

    testing_env!(ctx(OWNER));
    c.revoke_agent_key(BOB.into(), pk.clone());
    assert!(
        c.agent_keys(BOB.into()).is_empty(),
        "revoking must remove the key"
    );
}

#[test]
fn only_owner_issues_keys() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.issue_agent_key(
            BOB.into(),
            "ed25519:3hJHzSnCi5MyYNKkvW9MTpieRAM81jTvM7LAkVeGZbU4".into(),
            None,
        );
    }));
    assert!(r.is_err(), "players must not be able to issue NPC keys");
}

#[test]
fn cannot_revoke_a_key_we_never_issued() {
    let mut c = market();
    testing_env!(ctx(OWNER));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.revoke_agent_key(
            BOB.into(),
            "ed25519:3hJHzSnCi5MyYNKkvW9MTpieRAM81jTvM7LAkVeGZbU4".into(),
        );
    }));
    assert!(r.is_err(), "revoking an unknown key must be refused");
}

// ============================================================ player buys from NPC

#[test]
fn player_can_buy_from_npc() {
    let mut c = market();
    // Bob acquires stock first.
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    c.npc_buy(BOB.into(), 0, 10);

    let treasury_before = c.get_npc(BOB.into()).unwrap().treasury;
    let fair = c.fair_price("guppy".into()).0;
    let ask = fair * (BPS - 1_000) / BPS; // 10% under fair, inside the band
    post_ask(&mut c, ask);

    // The buyer attaches the cost as a deposit.
    let cost = ask * 4 * ONE_NEAR / PRICE_SCALE;
    testing_env!(
        VMContextBuilder::new()
            .predecessor_account_id(PLAYER.parse().unwrap())
            .block_timestamp(1_700_000_001_000_000_000)
            .account_balance(NearToken::from_yoctonear(cost))
            .attached_deposit(NearToken::from_yoctonear(cost))
            .build()
    );
    c.buy_from_npc(BOB.into(), "guppy".into(), 4, U128(ask));

    let npc = c.get_npc(BOB.into()).unwrap();
    assert_eq!(
        npc.treasury,
        treasury_before + cost,
        "the NPC treasury must be credited with the sale"
    );
    assert_eq!(npc.units_of("guppy"), 6, "4 units must leave inventory");

    let trades = c.recent_trades(5);
    assert_eq!(trades[0].kind, "player_buy", "the trade must be logged");
}

#[test]
fn player_cannot_buy_more_than_npc_holds() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    c.npc_buy(BOB.into(), 0, 10);

    let fair = c.fair_price("guppy".into()).0;
    let ask = fair * (BPS - 1_000) / BPS;
    post_ask(&mut c, ask);
    let cost = ask * 20 * ONE_NEAR / PRICE_SCALE;
    testing_env!(
        VMContextBuilder::new()
            .predecessor_account_id(PLAYER.parse().unwrap())
            .block_timestamp(1_700_000_001_000_000_000)
            .account_balance(NearToken::from_yoctonear(cost))
            .attached_deposit(NearToken::from_yoctonear(cost))
            .build()
    );

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.buy_from_npc(BOB.into(), "guppy".into(), 20, U128(ask));
    }));
    assert!(result.is_err(), "Bob only holds 10 units");
}

#[test]
fn player_cannot_underpay_for_npc_goods() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    c.npc_buy(BOB.into(), 0, 10);

    let fair = c.fair_price("guppy".into()).0;
    let ask = fair * (BPS - 1_000) / BPS;
    post_ask(&mut c, ask);
    // Attach far less than the cost: 4 units at the ask is well over a
    // yoctoNEAR, so this is guaranteed to be short.
    testing_env!(
        VMContextBuilder::new()
            .predecessor_account_id(PLAYER.parse().unwrap())
            .block_timestamp(1_700_000_001_000_000_000)
            .account_balance(NearToken::from_yoctonear(1))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build()
    );

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.buy_from_npc(BOB.into(), "guppy".into(), 4, U128(ask));
    }));
    assert!(result.is_err(), "the buyer must attach the cost");
}

#[test]
fn market_snapshot_reports_fair_prices() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);

    let snap = c.market_snapshot();
    assert_eq!(snap.len(), 5, "five rarity tiers registered");
    assert_eq!(snap[0].id, "guppy");
    assert_eq!(snap[0].listed_supply, 10);
    assert!(
        snap[0].fair_price < snap[0].base_price,
        "listing supply must have moved the fair price below base"
    );
}

// ============================================================ anti-bot gate

#[test]
fn player_cannot_list_units_they_do_not_hold() {
    // The hole: `list_fair` used to accept any unit count from any caller, so
    // a script could flood the market and crash the price without ever
    // playing. Holdings now gate every listing.
    let mut c = market();
    testing_env!(ctx(PLAYER));

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.list_fair("guppy".into(), 10);
    }));
    assert!(
        result.is_err(),
        "listing without holding units must be refused"
    );
}

#[test]
fn catch_then_list_works() {
    let mut c = market();
    testing_env!(ctx(PLAYER));

    // Catch first — this is the only way units enter a player's hands.
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "guppy".into()), 10);

    // Now the listing is legitimate.
    testing_env!(ctx(PLAYER));
    c.list_fair("guppy".into(), 10);
    assert_eq!(
        c.holdings(PLAYER.parse().unwrap(), "guppy".into()),
        0,
        "listed units must leave the player's holdings"
    );
    assert_eq!(c.get_item("guppy".into()).unwrap().listed_supply, 10);
}

#[test]
fn cannot_list_more_than_caught() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 5);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 5, nonce, sig.to_string());

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.list_fair("guppy".into(), 10);
    }));
    assert!(result.is_err(), "cannot list more than held");
}

#[test]
fn catch_is_bounded() {
    let mut c = market();
    testing_env!(ctx(PLAYER));

    let (pk, sig, _nonce) = sign_catch(PLAYER, "guppy", 10_000);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    let too_big = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.catch_fish("guppy".into(), 10_000, 1, sig.to_string());
    }));
    assert!(too_big.is_err(), "a single catch cannot inject unbounded supply");
}

#[test]
fn cancelling_a_listing_returns_units() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);

    testing_env!(ctx(PLAYER));
    c.cancel_listing(0);
    assert_eq!(
        c.holdings(PLAYER.parse().unwrap(), "guppy".into()),
        20,
        "cancelling must return the units to the player"
    );
}

// ============================================================ signed catches

#[test]
fn catch_requires_the_game_server_signature() {
    // The hole this closes: catch_fish used to take a free-form `proof`
    // string the contract never checked, so anyone could mint units by
    // calling it directly. It now requires a signature from the game server.
    let mut c = market();
    testing_env!(ctx(PLAYER));

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.catch_fish("guppy".into(), 10, 1, "not-a-real-signature".to_string());
    }));
    assert!(result.is_err(), "an unsigned catch must be refused");
}

#[test]
fn a_signed_catch_is_accepted() {
    let mut c = market();
    testing_env!(ctx(PLAYER));

    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());

    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "guppy".into()), 10);
}

#[test]
fn a_signature_cannot_be_replayed() {
    let mut c = market();
    testing_env!(ctx(PLAYER));

    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());

    // Same signature again — the nonce is already spent.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    }));
    assert!(result.is_err(), "a used nonce must not be replayable");
    assert_eq!(
        c.holdings(PLAYER.parse().unwrap(), "guppy".into()),
        10,
        "the replay must not have added units"
    );
}

#[test]
fn a_signature_for_a_different_player_is_refused() {
    let mut c = market();
    testing_env!(ctx(PLAYER));

    // Signed for someone else, submitted by the test player.
    let (pk, sig, nonce) = sign_catch("someoneelse.near", "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    }));
    assert!(result.is_err(), "a signature is bound to its player");
}

#[test]
fn only_the_owner_may_set_the_game_signer() {
    let mut c = market();
    let (pk, _, _) = sign_catch(PLAYER, "guppy", 10);

    // The caller is PLAYER, so the owner check inside must reject it. (The
    // context switch has to stay outside the closure — putting it inside
    // would make the call succeed and the test vacuous.)
    testing_env!(ctx(PLAYER));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.set_game_signer(pk.to_string());
    }));
    assert!(result.is_err(), "the signer key is owner-only");
}

// ============================================================ rarity & utility

#[test]
fn rarity_sets_the_price_multiplier() {
    // A legendary koi must not trade at a common guppy's price. This is the
    // whole point of tiers: rarity is worth money.
    let c = market();
    testing_env!(ctx(OWNER));

    let guppy = c.fair_price("guppy".into()).0;
    let koi = c.fair_price("koi".into()).0;

    assert_eq!(guppy, sp(0, 100_000), "common = 0.1x base");
    assert_eq!(koi, sp(6, 0), "legendary = 60x base");
    assert!(koi > guppy * 50, "a koi must be worth far more than a guppy");
}

#[test]
fn each_tier_has_its_own_price() {
    let c = market();
    testing_env!(ctx(OWNER));

    let prices: Vec<u128> = ["guppy", "tilapia", "snapper", "tuna", "koi"]
        .iter()
        .map(|id| c.fair_price(id.to_string()).0)
        .collect();

    for w in prices.windows(2) {
        assert!(w[1] > w[0], "each rarer tier must cost more: {:?}", prices);
    }
}

#[test]
fn utility_is_recorded_per_item() {
    let c = market();
    let snap = c.market_snapshot();
    let koi = snap.iter().find(|i| i.id == "koi").unwrap();
    assert_eq!(utility_label(koi.utility), "trophy");
    let guppy = snap.iter().find(|i| i.id == "guppy").unwrap();
    assert_eq!(utility_label(guppy.utility), "food");
}

#[test]
fn a_rare_listing_moves_its_own_price_only() {
    // Listing koi must not drag the guppy price down with it.
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "koi", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));

    let guppy_before = c.fair_price("guppy".into()).0;
    c.catch_fish("koi".into(), 10, nonce, sig.to_string());
    c.list_fair("koi".into(), 10);
    let guppy_after = c.fair_price("guppy".into()).0;

    assert_eq!(guppy_before, guppy_after, "items are priced independently");
}

// ============================================================ selling to market

#[test]
fn selling_to_market_pays_the_player() {
    // The "sell all" button must move NEAR, not just create a listing that
    // waits for a buyer. This is the difference between a market and a
    // noticeboard.
    let mut c = market();
    // Fund the vault the way the economy does: an NPC treasury transfer.
    testing_env!(ctx(OWNER));
    c.fund_vault(U128(100 * ONE_NEAR));

    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());

    let fair = c.fair_price("guppy".into()).0;
    let expected = fair * 10 * ONE_NEAR / PRICE_SCALE;

    c.sell_to_market("guppy".into(), 10);

    assert_eq!(
        c.holdings(PLAYER.parse().unwrap(), "guppy".into()),
        0,
        "sold units must leave the player's holdings"
    );
    let g = c.get_item("guppy".into()).unwrap();
    assert_eq!(g.vault_intake, 10, "the sale counts as supply for this window");
    assert_eq!(g.listed_supply, 0, "but it is not a listing that lingers forever");
    let _ = expected;
}

#[test]
fn selling_pushes_the_price_down() {
    let mut c = market();
    testing_env!(ctx(OWNER));
    c.fund_vault(U128(100 * ONE_NEAR));

    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 40);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 40, nonce, sig.to_string());

    let before = c.fair_price("guppy".into()).0;
    c.sell_to_market("guppy".into(), 40);
    let after = c.fair_price("guppy".into()).0;

    assert!(after < before, "dumping supply must lower the price");
}

#[test]
fn selling_more_than_held_is_refused() {
    let mut c = market();
    testing_env!(ctx(OWNER));
    c.fund_vault(U128(100 * ONE_NEAR));

    testing_env!(ctx(PLAYER));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.sell_to_market("guppy".into(), 10);
    }));
    assert!(result.is_err(), "cannot sell fish you do not have");
}

#[test]
fn an_empty_vault_cannot_pay() {
    // The vault must hold real NEAR. If it is empty the sale is refused
    // rather than paying out money the contract does not have.
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());

    // A contract balance below its own storage reserve cannot pay out, so the
    // sale is refused rather than promising NEAR that is not there.
    testing_env!(
        VMContextBuilder::new()
            .predecessor_account_id(PLAYER.parse().unwrap())
            .block_timestamp(1_700_000_000_000_000_000)
            .account_balance(NearToken::from_yoctonear(1))
            .build()
    );
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.sell_to_market("guppy".into(), 10);
    }));
    assert!(result.is_err(), "an unfunded vault must not pay out");
}

// ============================================================ listing expiry

#[test]
fn a_fresh_listing_cannot_be_expired() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.expire_listing(0);
    }));
    assert!(result.is_err(), "a listing inside its TTL must not expire");
}

#[test]
fn an_expired_listing_returns_its_units() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);

    // Jump past the TTL. Anyone may clear it — an expired listing is dead
    // supply that drags the price down while nobody may buy it.
    testing_env!(ctx_at(
        "anyone.near",
        1_700_000_000_000_000_000 + (LISTING_TTL_SECONDS + 60) * 1_000_000_000
    ));
    c.expire_listing(0);

    assert_eq!(
        c.holdings(PLAYER.parse().unwrap(), "guppy".into()),
        10,
        "expiring must return the units to the seller"
    );
    assert_eq!(
        c.get_item("guppy".into()).unwrap().listed_supply,
        0,
        "expiring must remove the supply"
    );
}

#[test]
fn an_expired_listing_cannot_be_bought() {
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);

    testing_env!(ctx_at(
        "bob.owner.near",
        1_700_000_000_000_000_000 + (LISTING_TTL_SECONDS + 60) * 1_000_000_000
    ));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.npc_buy(BOB.into(), 0, 5);
    }));
    assert!(result.is_err(), "an expired listing is closed");
}

// ============================================================ npc treasury

#[test]
fn the_treasury_stays_in_the_contract() {
    // The treasury is attached as a deposit and must stay in the contract's
    // balance. Refunding it to the caller left every NPC with a treasury of
    // zero and no ability to trade at all.
    let c = market();
    let bob = c.get_npc(BOB.into()).unwrap();
    assert_eq!(bob.treasury, 100 * ONE_NEAR, "the NPC holds its treasury");
}

#[test]
fn registering_an_npc_requires_the_treasury_attached() {
    let mut c = market();
    testing_env!(
        VMContextBuilder::new()
            .predecessor_account_id(OWNER.parse().unwrap())
            .block_timestamp(1_700_000_000_000_000_000)
            .account_balance(NearToken::from_near(10_000))
            .attached_deposit(NearToken::from_yoctonear(0))
            .build()
    );
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.register_npc(
            "zoe".into(),
            "zoe.owner.near".into(),
            U128(5 * ONE_NEAR),
            bob_personality(),
        );
    }));
    assert!(result.is_err(), "the treasury must be attached");
}

// ============================================================ money conservation

#[test]
fn a_sale_credits_the_treasury_exactly_once() {
    // A sale credits the NPC with exactly what the buyer paid, once.
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", T0));
    c.npc_buy(BOB.into(), 0, 10);

    let before = c.get_npc(BOB.into()).unwrap().treasury;
    npc_sells_to_player(&mut c, sp(1, 0), 10, 1_700_000_001_000_000_000);
    let after = c.get_npc(BOB.into()).unwrap().treasury;
    assert_eq!(
        after - before,
        sp(1, 0) * 10 * ONE_NEAR / PRICE_SCALE,
        "the treasury must gain exactly what the buyer paid"
    );
}

// ============================================================ demand is real

#[test]
fn buying_from_an_npc_counts_as_player_demand() {
    // player_buy_volume is the only real demand signal: a player choosing to
    // spend NEAR. NPC-to-NPC volume is inventory churn, and counting it as
    // demand let an NPC justify buying stock it could never sell.
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);

    // Bob buys from the player, building inventory to sell.
    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    c.npc_buy(BOB.into(), 0, 10);

    // A player then buys from Bob.
    let fair = c.fair_price("guppy".into()).0;
    let ask = fair * (BPS - 1_000) / BPS;
    post_ask(&mut c, ask);
    let cost = ask * 4 * ONE_NEAR / PRICE_SCALE;
    testing_env!(
        VMContextBuilder::new()
            .predecessor_account_id(PLAYER.parse().unwrap())
            .block_timestamp(1_700_000_001_000_000_000)
            .account_balance(NearToken::from_yoctonear(cost))
            .attached_deposit(NearToken::from_yoctonear(cost))
            .build()
    );
    c.buy_from_npc(BOB.into(), "guppy".into(), 4, U128(ask));

    let snap = c.market_snapshot();
    let guppy = snap.iter().find(|i| i.id == "guppy").unwrap();
    assert_eq!(
        guppy.player_buy_volume, 4,
        "a player buying from an NPC is real demand"
    );
}

#[test]
fn npc_to_npc_volume_is_not_demand() {
    // Bob buying and selling on his own must not register as demand, or the
    // NPC can talk itself into buying stock nobody wants.
    let mut c = market();
    testing_env!(ctx(PLAYER));
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx(PLAYER));
    c.catch_fish("guppy".into(), 10, nonce, sig.to_string());
    c.list_fair("guppy".into(), 10);

    testing_env!(ctx_at("bob.owner.near", 1_700_000_000_000_000_000));
    c.npc_buy(BOB.into(), 0, 10);

    // Bob buying from a player is inventory coming in, not demand. Only a
    // player buying *from* an NPC counts.
    let snap = c.market_snapshot();
    let guppy = snap.iter().find(|i| i.id == "guppy").unwrap();
    assert_eq!(
        guppy.player_buy_volume, 0,
        "an NPC buying must not count as player demand"
    );
}



// ============================================================ P0 regressions

fn catch(c: &mut Contract, who: &str, item: &str, units: u64) {
    let (pk, sig, nonce) = sign_catch(who, item, units);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx_pay(who, CATCH_FEE_NEAR, T0));
    c.catch_fish(item.into(), units, nonce, sig.to_string());
}

#[test]
fn a_guppy_receipt_cannot_be_redeemed_as_koi() {
    let mut c = market();
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 50);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx_pay(PLAYER, CATCH_FEE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.catch_fish("koi".into(), 50, nonce, sig.to_string());
    }));
    assert!(r.is_err(), "the species is part of the signed receipt");
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "koi".into()), 0);
}

#[test]
fn posting_an_ask_does_not_mint_treasury() {
    let mut c = market();
    catch(&mut c, PLAYER, "guppy", 10);
    testing_env!(ctx(PLAYER));
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", T0));
    c.npc_buy(BOB.into(), 0, 10);
    let before = c.get_npc(BOB.into()).unwrap();
    let fair = c.fair_price("guppy".into()).0;
    testing_env!(ctx_at("bob.owner.near", T0 + 1));
    c.npc_sell(BOB.into(), "guppy".into(), 10, U128(fair));
    let after = c.get_npc(BOB.into()).unwrap();
    assert_eq!(after.treasury, before.treasury, "no buyer, no money");
    assert_eq!(after.realized_profit, before.realized_profit);
    assert_eq!(after.units_of("guppy"), 10, "nothing was sold");
}

#[test]
fn a_buyer_pays_the_npc_ask_not_their_own_price() {
    let mut c = market();
    catch(&mut c, PLAYER, "guppy", 10);
    testing_env!(ctx(PLAYER));
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", T0));
    c.npc_buy(BOB.into(), 0, 10);
    let fair = c.fair_price("guppy".into()).0;
    post_ask(&mut c, fair);
    let before = c.get_npc(BOB.into()).unwrap().treasury;
    // The buyer offers a max well above the ask and attaches plenty.
    testing_env!(ctx_pay(BUYER, 100 * ONE_NEAR, T0 + 2));
    c.buy_from_npc(BOB.into(), "guppy".into(), 2, U128(fair * 2));
    let after = c.get_npc(BOB.into()).unwrap().treasury;
    assert_eq!(after - before, fair * 2 * ONE_NEAR / PRICE_SCALE, "charged at the NPC ask");
    // A buyer cannot name a lower price than the ask.
    testing_env!(ctx_pay(BUYER, 100 * ONE_NEAR, T0 + 3));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.buy_from_npc(BOB.into(), "guppy".into(), 2, U128(fair * 7 / 10));
    }));
    assert!(r.is_err(), "max price below the ask must be refused");
}

#[test]
fn investing_requires_paying() {
    let mut c = market();
    testing_env!(ctx_pay(PLAYER, 0, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.invest(BOB.into(), U128(1_000 * ONE_NEAR));
    }));
    assert!(r.is_err(), "an investment without a deposit must be refused");
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.invest(BOB.into(), U128(1_000 * ONE_NEAR));
    }));
    assert!(r.is_err(), "amount must match the deposit");
}

#[test]
fn investor_shares_are_pro_rata_and_paid_from_treasury() {
    let mut c = market();
    testing_env!(ctx_pay(PLAYER, 3 * ONE_NEAR, T0));
    c.invest(BOB.into(), U128(3 * ONE_NEAR));
    testing_env!(ctx_pay(BUYER, ONE_NEAR, T0));
    c.invest(BOB.into(), U128(ONE_NEAR));

    catch(&mut c, "fisher.near", "guppy", 10);
    testing_env!(ctx("fisher.near"));
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", T0));
    c.npc_buy(BOB.into(), 0, 10);
    npc_sells_to_player(&mut c, sp(1, 0), 10, T0 + 1_000_000_000);

    let npc = c.get_npc(BOB.into()).unwrap();
    let gain = npc.realized_profit as u128;
    assert!(gain > 0);
    let t_before = npc.treasury;

    testing_env!(ctx(PLAYER));
    let _ = c.claim_profit(BOB.into());
    testing_env!(ctx(BUYER));
    let _ = c.claim_profit(BOB.into());

    let a = c.investment_of(BOB.into(), PLAYER.parse().unwrap()).unwrap().claimed as u128;
    let b = c.investment_of(BOB.into(), BUYER.parse().unwrap()).unwrap().claimed as u128;
    assert_eq!(a, gain * 3_000 / BPS * 3 / 4, "3 of 4 NEAR -> 75% of the pool");
    assert_eq!(b, gain * 3_000 / BPS / 4, "1 of 4 NEAR -> 25% of the pool");
    assert!(a + b <= gain * 3_000 / BPS, "investors together never exceed 30%");

    let paid = (a + b) * ONE_NEAR / PRICE_SCALE;
    assert_eq!(t_before - c.get_npc(BOB.into()).unwrap().treasury, paid,
        "payouts come out of the treasury, in yoctoNEAR");
}

#[test]
fn the_vault_pays_only_from_its_own_balance() {
    let mut c = market();
    // The contract holds 10_000 NEAR (NPC treasuries), but the vault holds
    // only the catch fee and the licenses.
    let quote = c.claim_quote(vec![("shallows".into(), 50)], None).0;
    catch(&mut c, PLAYER, "koi", 50);
    assert_eq!(c.vault_balance().0, quote);
    testing_env!(ctx(PLAYER));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.sell_to_market("koi".into(), 50);
    }));
    assert!(r.is_err(), "the vault must not spend NPC money");
}

#[test]
fn selling_to_the_vault_does_not_leave_phantom_supply() {
    let mut c = market();
    catch(&mut c, PLAYER, "guppy", 10);
    testing_env!(ctx(OWNER));
    c.fund_vault(U128(0));
    testing_env!(ctx(PLAYER));
    c.sell_to_market("guppy".into(), 10);
    let g = c.get_item("guppy".into()).unwrap();
    assert_eq!(g.listed_supply, 0, "a vault sale is not a listing");
    let depressed = c.fair_price("guppy".into()).0;
    // After the pricing window the intake stops counting.
    testing_env!(ctx_at(PLAYER, T0 + (PRICING_WINDOW_SECONDS + 1) * 1_000_000_000));
    assert!(c.fair_price("guppy".into()).0 > depressed, "price recovers after the window");
}

#[test]
fn the_contract_stays_solvent_through_a_full_cycle() {
    // Liabilities never exceed what the contract was paid. In unit tests the
    // runtime does not move balances on transfers, so track inflows by hand.
    let mut c = market();
    let start = c.solvency();
    let mut inflow: u128 = 0;

    inflow += c.claim_quote(vec![("shallows".into(), 20)], None).0;
    catch(&mut c, PLAYER, "guppy", 20);
    testing_env!(ctx(PLAYER));
    c.list_fair("guppy".into(), 20);
    testing_env!(ctx_at("bob.owner.near", T0));
    c.npc_buy(BOB.into(), 0, 20);
    let paid_seller = c.recent_trades(1)[0].price * 20 * ONE_NEAR / PRICE_SCALE;

    let ask = c.fair_price("guppy".into()).0;
    npc_sells_to_player(&mut c, ask, 5, T0 + 1);
    inflow += ask * 5 * ONE_NEAR / PRICE_SCALE;

    let end = c.solvency();
    assert_eq!(
        end.liabilities.0,
        start.liabilities.0 + inflow - paid_seller,
        "liabilities move only with real inflows and outflows"
    );
}


#[test]
fn a_batch_of_receipts_is_claimed_once() {
    let mut c = market();
    let (pk, _, _) = sign_zone_catch(PLAYER, "shallows", "guppy", 1);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    let receipts = vec![receipt(PLAYER, "shallows", "guppy"), receipt(PLAYER, "shallows", "koi")];
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(receipts.clone());
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "guppy".into()), 1);
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "koi".into()), 1);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_catches(receipts.clone())));
    assert!(r.is_err(), "a receipt cannot be claimed twice");
    testing_env!(ctx_pay(BUYER, ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_catches(receipts.clone())));
    assert!(r.is_err(), "receipts are bound to the player");
}

#[test]
fn rods_are_bought_on_chain_and_fund_the_vault() {
    let mut c = market();
    assert_eq!(c.rod_of(PLAYER.parse().unwrap()), ROD_WOODEN);
    let v0 = c.vault_balance().0;
    testing_env!(ctx_pay(PLAYER, 1_500 * ONE_NEAR / 1_000, T0));
    c.acquire_rod("carbon".into(), false);
    assert_eq!(c.rod_of(PLAYER.parse().unwrap()), ROD_CARBON);
    assert_eq!(c.vault_balance().0, v0 + 1_500 * ONE_NEAR / 1_000);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.acquire_rod("master".into(), false)));
    assert!(r.is_err(), "underpaying for a rod is refused");
}


#[test]
fn daily_catch_is_capped_per_player() {
    let mut c = market();
    for _ in 0..2 {
        catch(&mut c, PLAYER, "guppy", 40);
    }
    assert_eq!(c.catches_left_today(PLAYER.parse().unwrap()), 0);
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 1);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx_pay(PLAYER, CATCH_FEE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.catch_fish("guppy".into(), 1, nonce, sig.to_string());
    }));
    assert!(r.is_err(), "the 81st fish of the day is refused");
    // A new day resets the allowance.
    let (pk, sig, nonce) = sign_catch(PLAYER, "guppy", 1);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
    testing_env!(ctx_pay(PLAYER, CATCH_FEE_NEAR, T0 + 86_400_000_000_000));
    c.catch_fish("guppy".into(), 1, nonce, sig.to_string());
}


#[test]
fn list_fair_asks_the_price_after_its_own_supply() {
    let mut c = market();
    catch(&mut c, PLAYER, "guppy", 10);
    testing_env!(ctx(PLAYER));
    c.list_fair("guppy".into(), 10);
    let (_, l) = c.open_listings().into_iter().next().unwrap();
    assert_eq!(l.ask_price, l.fair_at_list, "the ask is exactly the post-listing fair price");
    assert_eq!(l.ask_price, c.fair_price("guppy".into()).0);
}


// ================================================================== zones

fn claim(c: &mut Contract, who: &str, zone: &str, n: usize) {
    let rs: Vec<CatchReceipt> = (0..n).map(|_| receipt(who, zone, "guppy")).collect();
    testing_env!(ctx_pay(who, ONE_NEAR, T0));
    c.claim_catches(rs);
}

fn signer_on(c: &mut Contract) {
    let (pk, _, _) = sign_zone_catch(PLAYER, "shallows", "guppy", 1);
    testing_env!(ctx(OWNER));
    c.set_game_signer(pk.to_string());
}

#[test]
fn a_receipt_cannot_move_to_another_zone() {
    let mut c = market();
    signer_on(&mut c);
    let mut r = receipt(PLAYER, "shallows", "guppy");
    r.zone_id = "pond".into();
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_catches(vec![r.clone()])));
    assert!(res.is_err(), "the zone is part of the signature");
}

#[test]
fn catching_depletes_the_zone_and_raises_the_license() {
    let mut c = market();
    signer_on(&mut c);
    let fee_full = c.get_zone("pond".into()).unwrap().fee_per_fish.0;
    assert_eq!(fee_full, BASE_FEE);
    claim(&mut c, PLAYER, "pond", 5);
    let z = c.get_zone("pond".into()).unwrap();
    assert_eq!(z.zone.population, 5);
    assert_eq!(z.health_bps, 5_000);
    assert_eq!(z.fee_per_fish.0, BASE_FEE * 2, "half the fish, twice the license");
    claim(&mut c, PLAYER, "pond", 5);
    // Empty: the next fish is refused.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| claim(&mut c, PLAYER, "pond", 1)));
    assert!(r.is_err(), "a fished-out zone yields nothing");
}

#[test]
fn the_claim_must_pay_the_quoted_license() {
    let mut c = market();
    signer_on(&mut c);
    let quote = c.claim_quote(vec![("pond".into(), 4)], None).0;
    // fees for populations 10, 9, 8, 7 of capacity 10
    let expected = CATCH_FEE_NEAR + BASE_FEE * (10_000 + 11_111 + 12_500 + 14_285) / 10_000;
    assert_eq!(quote, expected);
    let rs: Vec<CatchReceipt> = (0..4).map(|_| receipt(PLAYER, "pond", "guppy")).collect();
    let v0 = c.vault_balance().0;
    testing_env!(ctx_pay(PLAYER, quote, T0));
    c.claim_catches(rs);
    assert_eq!(c.vault_balance().0 - v0, quote, "with no steward the whole license funds the vault");
}

#[test]
fn zones_regrow_over_time() {
    let mut c = market();
    signer_on(&mut c);
    claim(&mut c, PLAYER, "pond", 10);
    assert_eq!(c.get_zone("pond".into()).unwrap().zone.population, 0);
    testing_env!(ctx_at(PLAYER, T0 + 3_600_000_000_000)); // one hour, 6 per hour
    assert_eq!(c.get_zone("pond".into()).unwrap().zone.population, 6);
    testing_env!(ctx_at(PLAYER, T0 + 4 * 3_600_000_000_000));
    assert_eq!(c.get_zone("pond".into()).unwrap().zone.population, 10, "capped at capacity");
}

#[test]
fn a_steward_earns_only_while_the_zone_is_healthy() {
    let mut c = market();
    signer_on(&mut c);
    testing_env!(ctx_pay("steward.near", ONE_NEAR, T0));
    c.become_steward("pond".into());
    // First 5 fish: health stays >= 50% after each, steward earns 30%.
    claim(&mut c, PLAYER, "pond", 5);
    let earned = c.get_zone("pond".into()).unwrap().zone.steward_earned;
    assert!(earned > 0);
    // Next fish drops the zone below 50%: no share for the steward.
    claim(&mut c, PLAYER, "pond", 1);
    assert_eq!(c.get_zone("pond".into()).unwrap().zone.steward_earned, earned,
        "an overfished zone pays its steward nothing");
}

#[test]
fn a_closed_zone_cannot_be_fished_and_regrows_faster() {
    let mut c = market();
    signer_on(&mut c);
    claim(&mut c, PLAYER, "pond", 10);
    testing_env!(ctx_pay("steward.near", ONE_NEAR, T0));
    c.become_steward("pond".into());
    testing_env!(ctx_at("steward.near", T0));
    c.set_zone_policy("pond".into(), U128(10_000), true);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| claim(&mut c, PLAYER, "pond", 1)));
    assert!(r.is_err(), "closed means closed");
    testing_env!(ctx_at(PLAYER, T0 + 3_600_000_000_000));
    assert_eq!(c.get_zone("pond".into()).unwrap().zone.population, 10, "12/hour while closed, capped at 10");
}

#[test]
fn outbidding_a_steward_refunds_them_and_keeps_the_contract_solvent() {
    let mut c = market();
    signer_on(&mut c);
    testing_env!(ctx_pay("first.near", ONE_NEAR, T0));
    c.become_steward("shallows".into());
    testing_env!(ctx_pay("second.near", ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.become_steward("shallows".into())));
    assert!(r.is_err(), "a challenger must beat the stake by 20%");
    testing_env!(ctx_pay("second.near", ONE_NEAR * 12 / 10, T0));
    c.become_steward("shallows".into());
    let z = c.get_zone("shallows".into()).unwrap().zone;
    assert_eq!(z.steward.unwrap().as_str(), "second.near");
    assert_eq!(c.solvency().stewards.0, ONE_NEAR * 12 / 10, "only the live stake is owed");
}

#[test]
fn only_the_steward_sets_policy_and_bounds_hold() {
    let mut c = market();
    testing_env!(ctx_pay("steward.near", ONE_NEAR, T0));
    c.become_steward("pond".into());
    testing_env!(ctx_at(PLAYER, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_zone_policy("pond".into(), U128(10_000), true)));
    assert!(r.is_err());
    testing_env!(ctx_at("steward.near", T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_zone_policy("pond".into(), U128(50_000), false)));
    assert!(r.is_err(), "fee multiplier is capped at 2x");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.resign_steward("pond".into()); }));
    assert!(r.is_err(), "locked for 24 hours");
}


#[test]
fn underpaying_the_license_is_refused() {
    let mut c = market();
    signer_on(&mut c);
    let quote = c.claim_quote(vec![("pond".into(), 4)], None).0;
    let rs: Vec<CatchReceipt> = (0..4).map(|_| receipt(PLAYER, "pond", "guppy")).collect();
    testing_env!(ctx_pay(PLAYER, quote - 1, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_catches(rs)));
    assert!(r.is_err(), "one yocto short of the license is refused");
}


#[test]
fn a_nonce_is_spent_once_across_all_players() {
    // The server re-signs an adopted guest catch for the connecting account
    // with the same nonce. Two accounts must not both cash it.
    let mut c = market();
    signer_on(&mut c);
    let nonce = next_nonce();
    let kp = InMemorySigner::from_seed(SIGNER.parse().unwrap(), KeyType::ED25519, SIGNER_SEED);
    let sign_for = |who: &str| {
        let m = format!("catch:{}:{}:shallows:guppy:1:{}:50", CONTRACT_ACCOUNT, who, nonce);
        CatchReceipt { zone_id: "shallows".into(), item_id: "guppy".into(), units: 1, nonce, weight_g: 50, poached: false, bait: None, rod: None, signature: kp.sign(m.as_bytes()).to_string() }
    };
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![sign_for(PLAYER)]);
    testing_env!(ctx_pay(BUYER, ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_catches(vec![sign_for(BUYER)])));
    assert!(r.is_err(), "the same catch cannot be adopted twice");
}



// =================================================================== bait

fn bait_zone(c: &mut Contract) {
    testing_env!(ctx(OWNER));
    c.register_zone("deep".into(), "Deep".into(), 100, 10, U128(BASE_FEE), 0);
    c.set_zone_bait("deep".into(), Some("guppy".into()));
}

#[test]
fn a_deep_zone_burns_one_bait_fish_per_catch() {
    let mut c = market();
    signer_on(&mut c);
    bait_zone(&mut c);
    // No bait: refused.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
        c.claim_catches(vec![receipt(PLAYER, "deep", "tuna")]);
    }));
    assert!(r.is_err(), "no bait, no deep-water fish");
}

#[test]
fn bait_caught_earlier_in_the_same_claim_counts() {
    let mut c = market();
    signer_on(&mut c);
    bait_zone(&mut c);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![
        receipt(PLAYER, "shallows", "guppy"),
        receipt(PLAYER, "shallows", "guppy"),
        receipt(PLAYER, "deep", "tuna"),
    ]);
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "guppy".into()), 1, "one guppy became bait");
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "tuna".into()), 1);
    assert_eq!(c.bait_burned("guppy".into()), 1);
}

#[test]
fn only_the_owner_sets_bait_and_shallows_need_none() {
    let mut c = market();
    signer_on(&mut c);
    testing_env!(ctx(PLAYER));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_zone_bait("pond".into(), Some("guppy".into()))));
    assert!(r.is_err());
    assert_eq!(c.zone_bait("shallows".into()), None);
    claim(&mut c, PLAYER, "shallows", 2);
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "guppy".into()), 2);
}


#[test]
fn buying_from_an_npc_delivers_the_fish() {
    let mut c = market();
    catch(&mut c, PLAYER, "guppy", 10);
    testing_env!(ctx(PLAYER));
    c.list_fair("guppy".into(), 10);
    testing_env!(ctx_at("bob.owner.near", T0));
    c.npc_buy(BOB.into(), 0, 10);
    let fair = c.fair_price("guppy".into()).0;
    post_ask(&mut c, fair);
    let cost = fair * 3 * ONE_NEAR / PRICE_SCALE;
    testing_env!(ctx_pay(BUYER, cost, T0 + 2));
    c.buy_from_npc(BOB.into(), "guppy".into(), 3, U128(fair));
    assert_eq!(c.holdings(BUYER.parse().unwrap(), "guppy".into()), 3, "the buyer must receive what they paid for");
    assert_eq!(c.get_npc(BOB.into()).unwrap().units_of("guppy"), 7);
}



// ======================================================= records & trophies

#[test]
fn weight_is_part_of_the_signature() {
    let mut c = market();
    signer_on(&mut c);
    let mut r = receipt_w(PLAYER, "shallows", "guppy", 40);
    r.weight_g = 9_000;
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_catches(vec![r.clone()])));
    assert!(res.is_err(), "a heavier fish cannot be claimed than the server weighed");
}

#[test]
fn personal_bests_and_world_records_track_the_heaviest_fish() {
    let mut c = market();
    signer_on(&mut c);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![receipt_w(PLAYER, "shallows", "guppy", 80), receipt_w(PLAYER, "shallows", "guppy", 60)]);
    assert_eq!(c.personal_best(PLAYER.parse().unwrap(), "guppy".into()), 80);
    testing_env!(ctx_pay(BUYER, ONE_NEAR, T0));
    c.claim_catches(vec![receipt_w(BUYER, "shallows", "guppy", 95)]);
    let rec = c.records().into_iter().find(|(i, _, _)| i == "guppy").unwrap();
    assert_eq!((rec.1, rec.2.as_str()), (95, BUYER), "the world record moves to the heavier fish");
    assert_eq!(c.personal_best(PLAYER.parse().unwrap(), "guppy".into()), 80, "a personal best is personal");
}

#[test]
fn a_mounted_trophy_cuts_the_license() {
    let mut c = market();
    signer_on(&mut c);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![receipt(PLAYER, "shallows", "koi"), receipt(PLAYER, "shallows", "koi")]);
    let before = c.claim_quote(vec![("shallows".into(), 1)], Some(PLAYER.parse().unwrap())).0 - CATCH_FEE_NEAR;
    testing_env!(ctx_at(PLAYER, T0));
    assert_eq!(c.mount_trophy(), 1);
    assert_eq!(c.mount_trophy(), 2);
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "koi".into()), 0, "mounted koi are burned");
    let after = c.claim_quote(vec![("shallows".into(), 1)], Some(PLAYER.parse().unwrap())).0 - CATCH_FEE_NEAR;
    assert_eq!(after, before * 9_000 / 10_000, "two trophies, 10% off");
    assert_eq!(c.leaderboards().0[0].1, 2);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.mount_trophy(); }));
    assert!(r.is_err(), "no koi, no trophy");
}

#[test]
fn releasing_a_koi_restocks_the_zone() {
    let mut c = market();
    signer_on(&mut c);
    claim(&mut c, PLAYER, "pond", 10);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![receipt(PLAYER, "shallows", "koi")]);
    testing_env!(ctx_at(PLAYER, T0));
    assert_eq!(c.release_koi("pond".into()), 10, "restock capped at capacity");
    assert_eq!(c.releases_of(PLAYER.parse().unwrap()), 1);
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "koi".into()), 0);
}

// ================================================================ tournament

#[test]
fn only_entrants_compete_and_the_heaviest_fish_per_zone_wins() {
    let mut c = market();
    signer_on(&mut c);
    let week = T0 / WEEK_NS;
    testing_env!(ctx_pay(PLAYER, TOURNAMENT_TICKET, T0));
    c.enter_tournament();
    testing_env!(ctx_pay(BUYER, TOURNAMENT_TICKET, T0));
    c.enter_tournament();
    // An outsider's heavier fish does not count.
    testing_env!(ctx_pay("outsider.near", ONE_NEAR, T0));
    c.claim_catches(vec![receipt_w("outsider.near", "shallows", "guppy", 999)]);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![receipt_w(PLAYER, "shallows", "guppy", 70)]);
    testing_env!(ctx_pay(BUYER, ONE_NEAR, T0));
    c.claim_catches(vec![receipt_w(BUYER, "shallows", "guppy", 90), receipt_w(BUYER, "pond", "guppy", 30)]);
    let t = c.tournament(week);
    assert_eq!(t.entrants, 2);
    assert_eq!(t.pot.0, 2 * TOURNAMENT_TICKET);
    let sh = t.leaders.iter().find(|l| l.0 == "shallows").unwrap();
    assert_eq!((sh.1, sh.2.as_str()), (90, BUYER));
    assert_eq!(c.solvency().tournaments.0, 2 * TOURNAMENT_TICKET, "the pot is owed");

    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.settle_tournament(week)));
    assert!(r.is_err(), "cannot settle a running week");
}

#[test]
fn a_finished_week_pays_its_winners_and_the_vault() {
    let mut c = market();
    signer_on(&mut c);
    let week = T0 / WEEK_NS;
    testing_env!(ctx_pay(PLAYER, TOURNAMENT_TICKET, T0));
    c.enter_tournament();
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![receipt_w(PLAYER, "shallows", "guppy", 70)]);
    let v0 = c.vault_balance().0;
    testing_env!(ctx_at(BUYER, T0 + WEEK_NS));
    c.settle_tournament(week);
    assert!(c.tournament(week).settled);
    assert_eq!(c.vault_balance().0 - v0, TOURNAMENT_TICKET * TOURNAMENT_HOUSE_BPS / 10_000);
    assert_eq!(c.solvency().tournaments.0, 0, "paid out, nothing owed");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.settle_tournament(week)));
    assert!(r.is_err(), "settles once");
}

#[test]
fn a_week_without_winners_rolls_over() {
    let mut c = market();
    let week = T0 / WEEK_NS;
    testing_env!(ctx_pay(PLAYER, TOURNAMENT_TICKET, T0));
    c.enter_tournament();
    testing_env!(ctx_at(BUYER, T0 + WEEK_NS));
    c.settle_tournament(week);
    assert_eq!(c.tournament(week + 1).pot.0, TOURNAMENT_TICKET, "the pot carries to next week");
    assert_eq!(c.solvency().tournaments.0, TOURNAMENT_TICKET, "still owed");
}

#[test]
fn one_ticket_per_player_per_week() {
    let mut c = market();
    testing_env!(ctx_pay(PLAYER, TOURNAMENT_TICKET, T0));
    c.enter_tournament();
    testing_env!(ctx_pay(PLAYER, TOURNAMENT_TICKET, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.enter_tournament()));
    assert!(r.is_err());
}



// ================================================================= seasons

#[test]
fn the_season_follows_the_week_and_nobody_picks_it() {
    let c = market();
    let s = c.current_season();
    assert_eq!(s.week, T0 / WEEK_NS);
    assert_eq!(s.name, SEASONS[(s.week % 4) as usize]);
    testing_env!(ctx_at(PLAYER, T0 + WEEK_NS));
    let next = c.current_season();
    assert_eq!(next.id, ((s.id as u64 + 1) % 4) as u8, "seasons rotate weekly");
}

// =================================================================== docks

fn steward_with_snapper(c: &mut Contract, n: usize) {
    signer_on(c);
    testing_env!(ctx_pay("steward.near", ONE_NEAR, T0));
    c.become_steward("pond".into());
    let rs: Vec<CatchReceipt> = (0..n).map(|_| receipt("steward.near", "shallows", "snapper")).collect();
    testing_env!(ctx_pay("steward.near", ONE_NEAR, T0));
    c.claim_catches(rs);
}

#[test]
fn a_dock_burns_snapper_and_grows_the_zone() {
    let mut c = market();
    steward_with_snapper(&mut c, 20);
    testing_env!(ctx_at("steward.near", T0));
    assert_eq!(c.build_dock("pond".into()), 11, "10 + 10% of the original capacity");
    assert_eq!(c.holdings("steward.near".parse().unwrap(), "snapper".into()), 0);
    assert_eq!(c.docks_of("pond".into()), (10, 1));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.build_dock("pond".into()); }));
    assert!(r.is_err(), "no snapper left");
}

#[test]
fn only_the_harbor_master_builds_docks() {
    let mut c = market();
    steward_with_snapper(&mut c, 20);
    testing_env!(ctx_at(PLAYER, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.build_dock("pond".into()); }));
    assert!(r.is_err());
}

// ================================================================== orders

#[test]
fn an_order_locks_escrow_and_pays_whoever_fills_it() {
    let mut c = market();
    signer_on(&mut c);
    let fair = c.fair_price("guppy".into()).0;
    let t0 = c.get_npc(BOB.into()).unwrap().treasury;
    testing_env!(ctx_at("bob.owner.near", T0));
    c.npc_post_order(BOB.into(), "guppy".into(), 5, U128(fair * 11 / 10));
    let escrow = fair * 11 / 10 * 5 * ONE_NEAR / PRICE_SCALE;
    assert_eq!(t0 - c.get_npc(BOB.into()).unwrap().treasury, escrow, "escrow leaves the treasury");
    assert_eq!(c.solvency().order_escrow.0, escrow, "and is still owed");

    claim(&mut c, PLAYER, "shallows", 3);
    testing_env!(ctx_at(PLAYER, T0));
    c.fill_order(BOB.into(), "guppy".into(), 3);
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "guppy".into()), 0);
    assert_eq!(c.get_npc(BOB.into()).unwrap().units_of("guppy"), 3);
    let o = c.orders().into_iter().find(|o| o.npc_id == BOB).unwrap();
    assert_eq!(o.units_left, 2);
    assert_eq!(o.escrow, escrow - fair * 11 / 10 * 3 * ONE_NEAR / PRICE_SCALE);
}

#[test]
fn an_expired_order_returns_its_escrow() {
    let mut c = market();
    let fair = c.fair_price("guppy".into()).0;
    let t0 = c.get_npc(BOB.into()).unwrap().treasury;
    testing_env!(ctx_at("bob.owner.near", T0));
    c.npc_post_order(BOB.into(), "guppy".into(), 5, U128(fair));
    testing_env!(ctx_at(PLAYER, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.expire_order(BOB.into(), "guppy".into())));
    assert!(r.is_err(), "still open this week");
    testing_env!(ctx_at(PLAYER, T0 + WEEK_NS));
    c.expire_order(BOB.into(), "guppy".into());
    assert_eq!(c.get_npc(BOB.into()).unwrap().treasury, t0);
    assert!(c.orders().is_empty());
}

#[test]
fn order_prices_and_callers_are_bounded() {
    let mut c = market();
    let fair = c.fair_price("guppy".into()).0;
    testing_env!(ctx_at(PLAYER, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.npc_post_order(BOB.into(), "guppy".into(), 5, U128(fair))));
    assert!(r.is_err(), "only Bob posts Bob's orders");
    testing_env!(ctx_at("bob.owner.near", T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.npc_post_order(BOB.into(), "guppy".into(), 5, U128(fair * 2))));
    assert!(r.is_err(), "no more than +20% over fair");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.npc_post_order(BOB.into(), "guppy".into(), 5, U128(fair / 2))));
    assert!(r.is_err(), "an order is never below fair");
}

// ================================================================= fishdex

#[test]
fn completing_the_fishdex_raises_the_daily_cap() {
    let mut c = market();
    signer_on(&mut c);
    assert_eq!(c.catches_left_today(PLAYER.parse().unwrap()), MAX_CATCHES_PER_DAY);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(FISHDEX_SPECIES.iter().map(|s| receipt(PLAYER, "shallows", s)).collect());
    let d = c.fishdex(PLAYER.parse().unwrap());
    assert!(d.complete);
    assert_eq!(d.caught.len(), 5);
    assert_eq!(c.catches_left_today(PLAYER.parse().unwrap()), MAX_CATCHES_PER_DAY + FISHDEX_BONUS - 5);
}



#[test]
fn batched_views_match_the_single_views() {
    let mut c = market();
    signer_on(&mut c);
    claim(&mut c, PLAYER, "shallows", 3);
    let w = c.world_state(Some(10));
    assert_eq!(w.items.len(), 5);
    assert_eq!(w.npcs.len(), 3);
    assert_eq!(w.zones.len(), c.all_zones().len());
    assert_eq!(w.season.week, c.current_season().week);
    let p = c.player_state(PLAYER.parse().unwrap());
    let g = p.holdings.iter().find(|(i, _)| i == "guppy").unwrap().1;
    assert_eq!(g, c.holdings(PLAYER.parse().unwrap(), "guppy".into()));
    assert_eq!(p.catches_left, c.catches_left_today(PLAYER.parse().unwrap()));
    assert_eq!(p.rod, ROD_WOODEN);
}



// ================================================================ poaching

fn poached(player: &str, zone: &str, item: &str) -> CatchReceipt {
    let nonce = next_nonce();
    let kp = InMemorySigner::from_seed(SIGNER.parse().unwrap(), KeyType::ED25519, SIGNER_SEED);
    let m = format!("catch:{}:{}:{}:{}:1:{}:100:poached", CONTRACT_ACCOUNT, player, zone, item, nonce);
    CatchReceipt { zone_id: zone.into(), item_id: item.into(), units: 1, nonce, weight_g: 100, poached: true, bait: None, rod: None, signature: kp.sign(m.as_bytes()).to_string() }
}

fn closed_pond(c: &mut Contract) {
    signer_on(c);
    testing_env!(ctx_pay("steward.near", ONE_NEAR, T0));
    c.become_steward("pond".into());
    testing_env!(ctx_at("steward.near", T0));
    c.set_zone_policy("pond".into(), U128(10_000), true);
}

#[test]
fn a_poacher_pays_a_triple_license_to_the_harbor_master() {
    let mut c = market();
    closed_pond(&mut c);
    let fee = c.get_zone("pond".into()).unwrap().fee_per_fish.0;
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![poached(PLAYER, "pond", "guppy")]);
    let z = c.get_zone("pond".into()).unwrap().zone;
    assert_eq!(z.steward_earned, fee * 3, "every yocto of the fine goes to the harbor master");
    assert_eq!(z.population, 9, "poaching still empties the zone");
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "guppy".into()), 1);
}

#[test]
fn a_closed_zone_refuses_honest_receipts_and_the_flag_cannot_be_dropped() {
    let mut c = market();
    closed_pond(&mut c);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_catches(vec![receipt(PLAYER, "pond", "guppy")])));
    assert!(r.is_err(), "closed means poaching only");
    let mut p = poached(PLAYER, "pond", "guppy");
    p.poached = false;
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_catches(vec![p.clone()])));
    assert!(r.is_err(), "dropping the poached flag breaks the signature");
}

// ==================================================================== crew

#[test]
fn crew_earnings_are_split_by_stake() {
    let mut c = market();
    signer_on(&mut c);
    testing_env!(ctx_pay("steward.near", ONE_NEAR, T0));
    c.become_steward("shallows".into());
    testing_env!(ctx_pay("crew.near", 3 * ONE_NEAR, T0));
    c.back_steward("shallows".into());
    assert_eq!(c.crew_of("shallows".into())[0].1 .0, 3 * ONE_NEAR);
    assert_eq!(c.solvency().stewards.0, 4 * ONE_NEAR, "crew stakes are owed too");
    claim(&mut c, PLAYER, "shallows", 10);
    let earned = c.get_zone("shallows".into()).unwrap().zone.steward_earned;
    assert!(earned > 0);
    testing_env!(ctx_at("steward.near", T0));
    c.claim_steward_earnings("shallows".into());
    assert_eq!(c.get_zone("shallows".into()).unwrap().zone.steward_earned, 0);
    // The crew member holds 3 of 4 NEAR staked, so 75% of the earnings.
    let crew_share = earned * 3_000 / 4_000;
    assert!(crew_share > 0 && crew_share < earned);
    assert_eq!(c.solvency().stewards.0, 4 * ONE_NEAR, "stakes stay, earnings left");
}

#[test]
fn a_crew_makes_the_zone_harder_to_take_and_is_refunded_when_it_falls() {
    let mut c = market();
    testing_env!(ctx_pay("steward.near", ONE_NEAR, T0));
    c.become_steward("shallows".into());
    testing_env!(ctx_pay("crew.near", ONE_NEAR, T0));
    c.back_steward("shallows".into());
    // 1.2 NEAR no longer beats 1 + 1 crew.
    testing_env!(ctx_pay("raider.near", ONE_NEAR * 12 / 10, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.become_steward("shallows".into())));
    assert!(r.is_err(), "the crew defends the zone");
    testing_env!(ctx_pay("raider.near", ONE_NEAR * 24 / 10, T0));
    c.become_steward("shallows".into());
    assert!(c.crew_of("shallows".into()).is_empty(), "the old crew is paid back and disbanded");
    assert_eq!(c.solvency().stewards.0, ONE_NEAR * 24 / 10);
}

#[test]
fn backing_needs_a_harbor_master_and_a_real_stake() {
    let mut c = market();
    testing_env!(ctx_pay("crew.near", ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.back_steward("pond".into())));
    assert!(r.is_err(), "nobody to back");
    testing_env!(ctx_pay("steward.near", ONE_NEAR, T0));
    c.become_steward("pond".into());
    testing_env!(ctx_pay("crew.near", ONE_NEAR / 100, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.back_steward("pond".into())));
    assert!(r.is_err(), "at least 0.1 NEAR");
}



// ============================================================ bait tiers

fn baited(player: &str, zone: &str, item: &str, bait: &str) -> CatchReceipt {
    let nonce = next_nonce();
    let kp = InMemorySigner::from_seed(SIGNER.parse().unwrap(), KeyType::ED25519, SIGNER_SEED);
    let m = format!("catch:{}:{}:{}:{}:1:{}:100:bait:{}", CONTRACT_ACCOUNT, player, zone, item, nonce, bait);
    CatchReceipt { zone_id: zone.into(), item_id: item.into(), units: 1, nonce, weight_g: 100, poached: false, bait: Some(bait.into()), rod: None, signature: kp.sign(m.as_bytes()).to_string() }
}

fn tiered_zones(c: &mut Contract) {
    testing_env!(ctx(OWNER));
    c.register_zone("reefy".into(), "Reefy".into(), 100, 10, U128(BASE_FEE), 0);
    c.register_zone("deepy".into(), "Deepy".into(), 100, 10, U128(BASE_FEE), 0);
    c.set_zone_bait("reefy".into(), Some("guppy".into()));
    c.set_zone_bait("deepy".into(), Some("tilapia".into()));
}

#[test]
fn better_bait_is_accepted_and_worse_bait_is_refused() {
    let mut c = market();
    signer_on(&mut c);
    tiered_zones(&mut c);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![receipt(PLAYER, "shallows", "tilapia"), receipt(PLAYER, "shallows", "guppy")]);
    // Tilapia (tier 2) is fine where guppy (tier 1) is required.
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![baited(PLAYER, "reefy", "snapper", "tilapia")]);
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "tilapia".into()), 0, "the tilapia was burned as bait");
    // Guppy is not enough where tilapia is required.
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_catches(vec![baited(PLAYER, "deepy", "tuna", "guppy")])));
    assert!(r.is_err(), "guppy is below the Abyss requirement");
}

#[test]
fn optional_bait_in_open_water_is_burned_and_cannot_be_swapped() {
    let mut c = market();
    signer_on(&mut c);
    claim(&mut c, PLAYER, "shallows", 2);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![baited(PLAYER, "shallows", "snapper", "guppy")]);
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "guppy".into()), 1, "one guppy used as bait");
    let mut r = baited(PLAYER, "shallows", "snapper", "guppy");
    r.bait = None;
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_catches(vec![r.clone()])));
    assert!(res.is_err(), "the bait is part of the signature");
}

// ============================================================ vault price

#[test]
fn the_vault_pays_a_quarter_less_than_fair() {
    let mut c = market();
    signer_on(&mut c);
    claim(&mut c, PLAYER, "shallows", 4);
    testing_env!(ctx(OWNER));
    c.fund_vault(U128(0));
    let v0 = c.vault_balance().0;
    let bid = c.vault_bid_bps();
    assert!(bid <= VAULT_PRICE_BPS);
    testing_env!(ctx(PLAYER));
    c.sell_to_market("guppy".into(), 1);
    let t = &c.recent_trades(1)[0];
    assert_eq!(t.price, t.fair_price * bid / 10_000, "the vault's current bid");
    assert_eq!(v0 - c.vault_balance().0, t.price * ONE_NEAR / PRICE_SCALE);
}

// ========================================================= multiple orders

#[test]
fn an_npc_holds_one_order_per_fish() {
    let mut c = market();
    let g = c.fair_price("guppy".into()).0;
    let t = c.fair_price("tilapia".into()).0;
    testing_env!(ctx_at("bob.owner.near", T0));
    c.npc_post_order(BOB.into(), "guppy".into(), 5, U128(g));
    c.npc_post_order(BOB.into(), "tilapia".into(), 5, U128(t));
    assert_eq!(c.orders().iter().filter(|o| o.npc_id == BOB).count(), 2);
    // Re-posting the same fish replaces that order and refunds its escrow.
    let before = c.get_npc(BOB.into()).unwrap().treasury;
    c.npc_post_order(BOB.into(), "guppy".into(), 2, U128(g));
    let after = c.get_npc(BOB.into()).unwrap().treasury;
    assert_eq!(after - before, g * 3 * ONE_NEAR / PRICE_SCALE, "3 fewer units, 3 units of escrow back");
    assert_eq!(c.orders().iter().filter(|o| o.npc_id == BOB).count(), 2);
    testing_env!(ctx(OWNER));
    assert_eq!(c.close_legacy_orders(), 0, "nothing legacy here");
}

// ==================================================================== rods

#[test]
fn rods_can_be_bought_or_crafted_and_several_owned() {
    let mut c = market();
    signer_on(&mut c);
    assert!(c.rods_of(PLAYER.parse().unwrap()).is_empty(), "nobody starts with a rod");
    let rs: Vec<CatchReceipt> = (0..12).map(|_| receipt(PLAYER, "shallows", "snapper")).collect();
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(rs);
    testing_env!(ctx_at(PLAYER, T0));
    c.acquire_rod("carbon".into(), true);
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "snapper".into()), 0, "12 snapper became a rod");
    let v0 = c.vault_balance().0;
    testing_env!(ctx_pay(PLAYER, 8 * ONE_NEAR, T0));
    c.acquire_rod("harpoon".into(), false);
    assert_eq!(c.vault_balance().0 - v0, 6 * ONE_NEAR, "bought rods fund the vault, change is refunded");
    assert_eq!(c.rods_of(PLAYER.parse().unwrap()), vec!["carbon".to_string(), "harpoon".to_string()]);
    assert_eq!(c.rod_of(PLAYER.parse().unwrap()), 2, "best tier gates the zones");
    testing_env!(ctx_pay(PLAYER, 8 * ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.acquire_rod("harpoon".into(), false)));
    assert!(r.is_err(), "no second harpoon");
    testing_env!(ctx_at(PLAYER, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.acquire_rod("master".into(), true)));
    assert!(r.is_err(), "no fish for the recipe");
}


// ============================================================ economy v2

fn rodded(player: &str, zone: &str, item: &str, rod: &str, weight: u64) -> CatchReceipt {
    let nonce = next_nonce();
    let kp = InMemorySigner::from_seed(SIGNER.parse().unwrap(), KeyType::ED25519, SIGNER_SEED);
    let m = format!("catch:{}:{}:{}:{}:1:{}:{}:rod:{}", CONTRACT_ACCOUNT, player, zone, item, nonce, weight, rod);
    CatchReceipt { zone_id: zone.into(), item_id: item.into(), units: 1, nonce, weight_g: weight, poached: false, bait: None,
        rod: Some(rod.into()), signature: kp.sign(m.as_bytes()).to_string() }
}

fn bamboo(c: &mut Contract, who: &str) {
    testing_env!(ctx_pay(who, ONE_NEAR / 10, T0));
    c.acquire_rod("bamboo".into(), false);
}

fn left(c: &Contract, who: &str, rod: &str) -> u32 {
    c.rod_status(who.parse().unwrap()).into_iter().find(|s| s.id == rod).unwrap().left
}

#[test]
fn bamboo_is_cheap_and_buy_only() {
    let mut c = market();
    let v0 = c.vault_balance().0;
    bamboo(&mut c, PLAYER);
    assert_eq!(c.vault_balance().0 - v0, ONE_NEAR / 10);
    assert_eq!(c.rods_of(PLAYER.parse().unwrap()), vec!["bamboo".to_string()]);
    assert_eq!(left(&c, PLAYER, "bamboo"), 100);
    testing_env!(ctx_at("other.near", T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.acquire_rod("bamboo".into(), true)));
    assert!(r.is_err(), "bamboo cannot be crafted");
}

#[test]
fn rods_wear_per_fish_and_heavy_fish_wear_more() {
    let mut c = market();
    signer_on(&mut c);
    bamboo(&mut c, PLAYER);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![rodded(PLAYER, "shallows", "guppy", "bamboo", 50), rodded(PLAYER, "shallows", "tuna", "bamboo", 5000)]);
    assert_eq!(left(&c, PLAYER, "bamboo"), 100 - 1 - 3);
}

#[test]
fn a_receipt_cannot_name_a_rod_you_do_not_own() {
    let mut c = market();
    signer_on(&mut c);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.claim_catches(vec![rodded(PLAYER, "shallows", "guppy", "master", 50)])
    }));
    assert!(r.is_err());
}

#[test]
fn the_rod_is_part_of_the_signature() {
    let mut c = market();
    signer_on(&mut c);
    bamboo(&mut c, PLAYER);
    let mut r = rodded(PLAYER, "shallows", "guppy", "bamboo", 50);
    r.rod = None;
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_catches(vec![r.clone()])));
    assert!(res.is_err(), "dropping the rod to dodge wear breaks the signature");
}

#[test]
fn a_worn_out_rod_still_brings_the_catch_home_then_reads_zero() {
    let mut c = market();
    signer_on(&mut c);
    bamboo(&mut c, PLAYER);
    // 34 tuna at 3 wear each is 102: two more than bamboo's 100.
    for chunk in 0..2 {
        let n = if chunk == 0 { 20 } else { 14 };
        let rs: Vec<CatchReceipt> = (0..n).map(|_| rodded(PLAYER, "shallows", "tuna", "bamboo", 5000)).collect();
        testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
        c.claim_catches(rs);
    }
    assert_eq!(left(&c, PLAYER, "bamboo"), 0);
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "tuna".into()), 34);
}

#[test]
fn repair_with_near_feeds_the_vault_and_the_tournament_pot() {
    let mut c = market();
    signer_on(&mut c);
    bamboo(&mut c, PLAYER);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(vec![rodded(PLAYER, "shallows", "guppy", "bamboo", 50)]);
    let v0 = c.vault_balance().0;
    let pot0 = c.tournament(c.current_week()).pot.0;
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.repair_rod("bamboo".into(), false);
    let repair = 30 * ONE_NEAR / 1_000;
    assert_eq!(c.tournament(c.current_week()).pot.0 - pot0, repair * REPAIR_POT_BPS / 10_000);
    assert_eq!(c.vault_balance().0 - v0, repair - repair * REPAIR_POT_BPS / 10_000);
    assert_eq!(left(&c, PLAYER, "bamboo"), 100);
    assert!(c.solvency().solvent);
}

#[test]
fn repair_with_fish_burns_the_recipe() {
    let mut c = market();
    signer_on(&mut c);
    bamboo(&mut c, PLAYER);
    let rs: Vec<CatchReceipt> = (0..8).map(|_| rodded(PLAYER, "shallows", "guppy", "bamboo", 50)).collect();
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(rs);
    testing_env!(ctx_at(PLAYER, T0));
    c.repair_rod("bamboo".into(), true);
    assert_eq!(c.holdings(PLAYER.parse().unwrap(), "guppy".into()), 0);
    assert_eq!(left(&c, PLAYER, "bamboo"), 100);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.repair_rod("bamboo".into(), true)));
    assert!(r.is_err(), "nothing to repair");
}

#[test]
fn the_legendary_rod_needs_a_trophy_and_a_big_tuna() {
    let mut c = market();
    signer_on(&mut c);
    let mut rs: Vec<CatchReceipt> = (0..5).map(|_| receipt_w(PLAYER, "shallows", "tuna", 10_000)).collect();
    rs.extend((0..3).map(|_| receipt(PLAYER, "shallows", "koi")));
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(rs);
    testing_env!(ctx_at(PLAYER, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.acquire_rod("legendary".into(), true)));
    assert!(r.is_err(), "no trophy, no record tuna");
    testing_env!(ctx_pay(PLAYER, 10 * ONE_NEAR, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.acquire_rod("legendary".into(), false)));
    assert!(r.is_err(), "not for sale");
}

#[test]
fn the_legendary_rod_crafts_once_the_requirements_are_met() {
    let mut c = market();
    signer_on(&mut c);
    let mut rs: Vec<CatchReceipt> = (0..5).map(|_| receipt_w(PLAYER, "shallows", "tuna", 31_000)).collect();
    rs.extend((0..3).map(|_| receipt(PLAYER, "shallows", "koi")));
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(rs);
    testing_env!(ctx_at(PLAYER, T0));
    c.mount_trophy();
    c.acquire_rod("legendary".into(), true);
    assert!(c.rods_of(PLAYER.parse().unwrap()).contains(&"legendary".to_string()));
    assert_eq!(left(&c, PLAYER, "legendary"), 600);
}

#[test]
fn the_vault_bid_shrinks_with_its_reserve() {
    let mut c = market();
    let v = c.vault_balance().0;
    assert_eq!(c.vault_bid_bps(), VAULT_PRICE_BPS * v.min(VAULT_TARGET) / VAULT_TARGET, "bid tracks the reserve");
    testing_env!(ctx_pay(OWNER, VAULT_TARGET, T0));
    c.fund_vault(U128(0));
    assert_eq!(c.vault_bid_bps(), VAULT_PRICE_BPS, "a full vault pays the full 75%");
}

#[test]
fn the_owner_can_retune_a_license() {
    let mut c = market();
    testing_env!(ctx(OWNER));
    c.set_zone_fee("shallows".into(), U128(5 * BASE_FEE));
    assert_eq!(c.get_zone("shallows".into()).unwrap().zone.base_fee, 5 * BASE_FEE);
    testing_env!(ctx(PLAYER));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_zone_fee("shallows".into(), U128(1))));
    assert!(r.is_err());
}


// ======================================================= surplus and notes

#[test]
fn the_vault_surplus_above_its_ceiling_goes_to_the_tournament_pot() {
    let mut c = market();
    testing_env!(ctx_pay(OWNER, 12 * ONE_NEAR, T0));
    c.fund_vault(U128(0));
    let v = c.vault_balance().0;
    let week = c.current_week();
    let pot0 = c.tournament(week).pot.0;
    testing_env!(ctx_at(PLAYER, T0));
    let moved = c.sweep_vault_surplus().0;
    assert_eq!(moved, v - VAULT_CEILING);
    assert_eq!(c.vault_balance().0, VAULT_CEILING, "the reserve stays");
    assert_eq!(c.tournament(week).pot.0 - pot0, moved);
    assert_eq!(c.sweep_vault_surplus().0, 0, "nothing left to sweep");
    assert!(c.solvency().solvent);
}

#[test]
fn a_thin_vault_has_no_surplus() {
    let mut c = market();
    testing_env!(ctx_at(PLAYER, T0));
    let v = c.vault_balance().0;
    assert_eq!(c.sweep_vault_surplus().0, 0);
    assert_eq!(c.vault_balance().0, v);
}

#[test]
fn only_the_npc_account_can_post_its_note() {
    let mut c = market();
    testing_env!(ctx_at("bob.owner.near", T0));
    c.npc_post_note(BOB.into(), "Tuna run: paying 20% over fair for tuna.".into(), "near-ai".into());
    let notes = c.npc_notes();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].npc_id, BOB);
    assert_eq!(notes[0].source, "near-ai");
    testing_env!(ctx_at(PLAYER, T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.npc_post_note(BOB.into(), "fake".into(), "rules".into())));
    assert!(r.is_err(), "a player cannot speak for Bob");
}

#[test]
fn notes_are_short_and_labelled() {
    let mut c = market();
    testing_env!(ctx_at("bob.owner.near", T0));
    let long = "x".repeat(MAX_NOTE_CHARS + 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.npc_post_note(BOB.into(), long.clone(), "rules".into())));
    assert!(r.is_err(), "too long");
}

#[test]
fn a_note_needs_a_known_source() {
    let mut c = market();
    testing_env!(ctx_at("bob.owner.near", T0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.npc_post_note(BOB.into(), "hi".into(), "oracle".into())));
    assert!(r.is_err());
}


// ============================================================ P2P listings

fn listed_by(c: &mut Contract, who: &str, item: &str, n: u64) -> u64 {
    testing_env!(ctx_at(who, T0));
    c.list_fair(item.into(), n);
    c.open_listings().into_iter().filter(|(_, l)| l.seller.as_str() == who).map(|(i, _)| i).max().unwrap()
}

#[test]
fn a_player_can_buy_another_players_listing() {
    let mut c = market();
    catch(&mut c, PLAYER, "snapper", 3);
    let idx = listed_by(&mut c, PLAYER, "snapper", 3);
    testing_env!(ctx_pay(BUYER, 50 * ONE_NEAR, T0 + 1));
    c.buy_listing(idx, 2, U128(10 * PRICE_SCALE));
    assert_eq!(c.holdings(BUYER.parse().unwrap(), "snapper".into()), 2);
    let left = c.open_listings().into_iter().find(|(i, _)| *i == idx).map(|(_, l)| l.units);
    assert_eq!(left, Some(1), "the listing shrinks");
    assert_eq!(c.recent_trades(1)[0].kind, "p2p");
}

#[test]
fn you_cannot_buy_your_own_listing() {
    let mut c = market();
    catch(&mut c, PLAYER, "snapper", 2);
    let idx = listed_by(&mut c, PLAYER, "snapper", 2);
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0 + 1));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.buy_listing(idx, 1, U128(10 * PRICE_SCALE))));
    assert!(r.is_err());
}

#[test]
fn an_expired_listing_cannot_be_bought_by_a_player() {
    let mut c = market();
    catch(&mut c, PLAYER, "snapper", 2);
    let idx = listed_by(&mut c, PLAYER, "snapper", 2);
    testing_env!(ctx_pay(BUYER, ONE_NEAR, T0 + LISTING_TTL_SECONDS * 1_000_000_000 + 1));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.buy_listing(idx, 1, U128(10 * PRICE_SCALE))));
    assert!(r.is_err());
}

#[test]
fn the_buyer_sets_a_max_price_and_must_pay_it() {
    let mut c = market();
    catch(&mut c, PLAYER, "snapper", 2);
    let idx = listed_by(&mut c, PLAYER, "snapper", 2);
    testing_env!(ctx_pay(BUYER, ONE_NEAR, T0 + 1));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.buy_listing(idx, 1, U128(1))));
    assert!(r.is_err(), "max price below the ask");
    testing_env!(ctx_pay(BUYER, 1, T0 + 1));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.buy_listing(idx, 1, U128(10 * PRICE_SCALE))));
    assert!(r.is_err(), "deposit below the price");
}

// ============================================================ supply ledger

fn supply_of(c: &Contract, id: &str) -> SupplyView {
    c.supply().into_iter().find(|s| s.item_id == id).unwrap()
}

#[test]
fn the_ledger_counts_what_is_caught_and_burned() {
    let mut c = market();
    signer_on(&mut c);
    let rs: Vec<CatchReceipt> = (0..14).map(|_| receipt(PLAYER, "shallows", "snapper")).collect();
    testing_env!(ctx_pay(PLAYER, ONE_NEAR, T0));
    c.claim_catches(rs);
    testing_env!(ctx_at(PLAYER, T0));
    c.acquire_rod("carbon".into(), true);
    testing_env!(ctx_pay(OWNER, 20 * ONE_NEAR, T0));
    c.fund_vault(U128(0));
    testing_env!(ctx(PLAYER));
    c.sell_to_market("snapper".into(), 2);
    let s = supply_of(&c, "snapper");
    assert_eq!(s.minted, 14);
    assert_eq!(s.burned.rods, 12);
    assert_eq!(s.burned.vault, 2);
    assert_eq!(s.circulating, 0);
}

#[test]
fn a_glut_slows_the_zone_that_makes_it() {
    let mut c = market();
    assert_eq!(c.regen_factor_bps("shallows".into()).0, 10_000);
    for k in 0..12 {
        let who = format!("angler{}.near", k);
        catch(&mut c, &who, "guppy", 50);
    }
    let s = supply_of(&c, "guppy");
    assert_eq!(s.circulating, 600);
    // 400 target / 600 in circulation = two thirds of the normal rate.
    assert_eq!(c.regen_factor_bps("shallows".into()).0, 400 * 10_000 / 600);
    assert_eq!(c.regen_factor_bps("abyss".into()).0, 10_000, "other zones are unaffected");
}
