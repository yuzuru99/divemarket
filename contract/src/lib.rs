//! DiveMarket — a living on-chain economy where NPCs hold real treasuries,
//! trade autonomously, and move prices through verifiable supply and demand.
//!
//! Built for NEAR HACKATHON: Build Beyond Boundaries — track: Games With Real
//! Economies.
//!
//! Design rules this contract is built around
//! ------------------------------------------
//! 1. **Pricing is deterministic and on-chain.** No AI, no oracle, no admin
//!    sets a price. `fair_price` is a pure function of on-chain counters:
//!    listed supply, buy volume, NPC inventory, and active events. An AI can
//!    decide *when* to trade; it can never decide *what a thing is worth*.
//!
//! 2. **NPC treasuries are real.** Each NPC has its own NEAR balance tracked
//!    by this contract. An NPC cannot mint, borrow, or spend money it does
//!    not have. A broke NPC is broke until it earns or is funded.
//!
//! 3. **Settlement is on-chain, cognition is off-chain.** NPC "thinking"
//!    happens in a Node.js engine that only reads public views and emits
//!    BUY / SELL / HOLD. A backend validates each decision against the
//!    limits below, then signs it with a function-call key scoped to this
//!    contract. No LLM ever holds a key.
//!
//! 4. **Wash trading is structurally discouraged.** Minimum and maximum order
//!    sizes, a per-NPC trade rate limit, and an outright ban on self-trades
//!    (same account on both sides) are all enforced here, where they cannot
//!    be argued with.
//!
//! 5. **Profit is realized, not marked to market.** NPC inventory carries a
//!    FIFO cost basis, so "profit" means sold-for-more-than-paid, never
//!    "the price went up while I held it". Investor payouts are computed
//!    from realized profit only.

use near_sdk::borsh::BorshDeserialize;
use near_sdk::collections::{LookupMap, UnorderedMap, UnorderedSet, Vector};
use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::{
    env, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
    PublicKey,
};

/// Price scaling factor. All internal prices are stored as
/// `yoctoNEAR_per_unit * PRICE_SCALE`, so a "price" of 1.5 NEAR is stored as
/// 1_500_000. Integer math only — no floats anywhere in the pricing path,
/// because a float would make the price depend on the evaluator.
pub const PRICE_SCALE: u128 = 1_000_000;

/// One NEAR in yoctoNEAR. Used to convert scaled prices into real money.
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// Basis-point denominator. 10_000 bps = 100%.
pub const BPS: u128 = 10_000;

/// How much one unit of buy volume moves demand, in bps, at the reference
/// volume. demand_factor = 1 + (buy_volume / DEMAND_REFERENCE) * DEMAND_WEIGHT
const DEMAND_REFERENCE: u128 = 20;
const DEMAND_WEIGHT_BPS: u128 = 6_000; // 60% at reference volume

/// How much listed supply moves the supply factor.
pub const SUPPLY_REFERENCE: u128 = 100;
const SUPPLY_WEIGHT_BPS: u128 = 2_500;

/// How much total NPC inventory moves scarcity.
pub const SCARCITY_REFERENCE: u128 = 100;
const SCARCITY_WEIGHT_BPS: u128 = 2_000;

/// Hard ceiling on any single factor, so a runaway counter cannot produce an
/// absurd price. 5x on demand, 0.4x floor on supply and scarcity.
///
/// The floor is deliberately not lower: a price that can fall to a fifth of
/// base makes large listings self-defeating (the listing itself pushes the
/// ask out of the overpay band), which is not a property a working market
/// should have.
const MAX_FACTOR_BPS: u128 = 50_000;
const MIN_FACTOR_BPS: u128 = 4_000;

/// Maximum number of distinct items the market can list.
const MAX_ITEMS: usize = 64;

/// Maximum number of NPCs.
const MAX_NPCS: usize = 32;

/// Maximum open listings per seller.
const MAX_LISTINGS_PER_SELLER: usize = 50;

/// Maximum trades one NPC may make per rate-limit window. This is the main
/// anti-wash-trading lever: volume that cannot be produced organically by a
/// single NPC cannot be produced at all.
pub const MAX_TRADES_PER_WINDOW: u64 = 20;

/// Length of the trade rate-limit window, in seconds.
const TRADE_WINDOW_SECONDS: u64 = 3600;

/// Length of the pricing window, in seconds. Buy and sell volumes are
/// measured inside this window and reset when it rolls over, so the price
/// reflects *recent* activity rather than all-time totals.
pub const PRICING_WINDOW_SECONDS: u64 = 3600;

/// Minimum order size in units. Below this, an order is refused.
pub const MIN_ORDER_UNITS: u64 = 1;

/// Maximum order size in units per trade.
pub const MAX_ORDER_UNITS: u64 = 1_000;

/// How long a listing stays open before it expires.
///
/// Without this, a listing priced fairly at creation becomes unsellable as
/// the market moves, and it sits in the supply forever — dragging the price
/// down while nobody may buy it. Expiring returns the units and lets the
/// seller re-list at the current price.
pub const LISTING_TTL_SECONDS: u64 = 1800; // 30 minutes

/// How many trades the on-chain feed keeps. The feed is a UI convenience,
/// not an audit trail; an unbounded log makes the contract's storage grow
/// with every trade until it can no longer afford to store its own state.
pub const MAX_TRADE_LOG: u64 = 50;

/// NEAR a new listing costs the contract in storage. Charged to whoever
/// creates the listing, so the contract never runs out of NEAR to store its
/// own state.
pub const LISTING_STORAGE_COST: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR

/// Maximum units a single catch may report. Bounds how much supply one call
/// can inject, so a compromised client cannot mint a market crash.
pub const MAX_CATCH_UNITS: u64 = 50;

/// Most receipts one `claim_catches` call may carry. Each receipt is one
/// signature check, so this bounds the gas of a claim.
pub const MAX_RECEIPTS_PER_CLAIM: usize = 40;

/// Most fish one player may bring into the economy per UTC day. However
/// many casts a bot opens in parallel, supply per account is bounded here.
pub const MAX_CATCHES_PER_DAY: u64 = 80;

// ------------------------------------------------------------------ zones
//
// The sea is finite. Each zone holds a fish population that regenerates
// slowly toward its capacity. Every fish claimed comes out of that
// population, and the license fee per fish rises as the zone thins out, so
// overfishing is self-limiting: the sink grows exactly when players get
// greedy. A steward stakes NEAR to manage a zone and earns a share of its
// licenses, but only while the zone stays healthy.

/// Raw storage key holding the list of zone ids (borsh Vec<String>).
const ZONE_IDS_KEY: &[u8] = b"zone_ids";
/// Steward's share of license revenue, in bps.
pub const STEWARD_SHARE_BPS: u128 = 3_000;
/// Health (population / capacity, bps) a zone must keep for its steward to
/// be paid. Below this the steward's share goes to the vault instead.
pub const STEWARD_HEALTH_BPS: u128 = 5_000;
/// Minimum stake to become a zone's steward.
pub const STEWARD_MIN_STAKE: u128 = ONE_NEAR;
/// A challenger must stake at least this much of the current stake (bps).
pub const STEWARD_OUTBID_BPS: u128 = 12_000;
/// How long a steward must serve before resigning.
pub const STEWARD_LOCK_SECONDS: u64 = 86_400;
/// The license tops out at 10x the base when a zone is nearly empty.
pub const MAX_SCARCITY_BPS: u128 = 100_000;
const HOUR_NS: u128 = 3_600_000_000_000;

// ------------------------------------------------- records, trophies, cups

/// License discount per mounted koi trophy, in bps, and its cap.
pub const TROPHY_DISCOUNT_BPS: u128 = 500;
pub const MAX_TROPHY_DISCOUNT_BPS: u128 = 5_000;
/// Fish a released koi adds back to its zone.
pub const KOI_RELEASE_RESTOCK: u64 = 20;
/// Weekly tournament ticket, and the vault's cut of each pot.
pub const TOURNAMENT_TICKET: u128 = ONE_NEAR / 10;
pub const TOURNAMENT_HOUSE_BPS: u128 = 500;
pub const WEEK_NS: u64 = 7 * 86_400 * 1_000_000_000;
const TOP_N: usize = 10;
const TROPHY_TOP_KEY: &[u8] = b"top_trophies";
const RELEASE_TOP_KEY: &[u8] = b"top_releases";
const TOURNEY_HELD_KEY: &[u8] = b"tourney_held";

// ------------------------------------------- seasons, docks, orders, dex

/// The sea changes every week on its own: the season is the week number
/// modulo 4, so nobody (not even the owner) picks it.
pub const SEASONS: [&str; 4] = ["calm", "storm", "koi_run", "tuna_run"];
/// Snapper a harbor master burns per dock, the capacity each dock adds (as a
/// fraction of the zone's original capacity), and the most docks per zone.
pub const DOCK_SNAPPER: u64 = 20;
pub const DOCK_CAPACITY_BPS: u128 = 1_000;
pub const MAX_DOCKS: u64 = 10;
/// The species a player must land to complete the Fishdex, and its reward.
pub const FISHDEX_SPECIES: [&str; 5] = ["guppy", "tilapia", "snapper", "tuna", "koi"];
pub const FISHDEX_BONUS: u64 = 20;
pub const MAX_ORDER_SIZE: u64 = 100;
/// A poached fish (taken from a closed zone) pays this multiple of the
/// license, all of it to the zone's harbor master.
pub const POACH_FINE_MULTIPLIER: u128 = 3;
/// The vault buys at a discount to fair: instant cash, but the best price is
/// always an NPC order or listing.
pub const VAULT_PRICE_BPS: u128 = 7_500;
/// The vault pays its full 75% only while it holds at least this much; below
/// it, the bid shrinks in proportion, so heavy selling can never drain it.
pub const VAULT_TARGET: u128 = 5 * ONE_NEAR;
/// What the vault holds beyond this goes back to players: anyone may sweep
/// the surplus into this week's tournament pot.
pub const VAULT_CEILING: u128 = 10 * ONE_NEAR;
/**
 * Supply control. Each zone's regrowth is tied to how much of its staple
 * fish is in circulation (caught minus burned): above the target, the zone
 * regrows more slowly, down to a quarter of its rate, so a glut corrects
 * itself without anyone stepping in.
 */
pub const SUPPLY_TARGETS: [(&str, &str, u64); 3] = [("shallows", "guppy", 400), ("reef", "tilapia", 300), ("abyss", "tuna", 150)];
pub const MIN_REGEN_BPS: u128 = 2_500;

/// Fish taken out of circulation for good, by where they went.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Burned {
    pub rods: u64,
    pub vault: u64,
    pub docks: u64,
    pub koi: u64,
}

/// One fish's supply, as the Market shows it.
#[near(serializers = [json])]
pub struct SupplyView {
    pub item_id: String,
    pub minted: u64,
    pub burned_bait: u64,
    pub burned: Burned,
    pub circulating: u64,
    /// Circulation target for this fish, if a zone's regrowth follows it.
    pub target: Option<u64>,
    pub zone: Option<String>,
    /// That zone's regrowth right now, in basis points of its normal rate.
    pub regen_bps: Option<U128>,
}

/// Longest market note an NPC may publish.
pub const MAX_NOTE_CHARS: usize = 240;

/// A short market note an NPC publishes from its own account: what its
/// decision engine (NEAR AI Cloud, or the rule fallback) is doing and why.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct NpcNote {
    pub npc_id: String,
    pub text: String,
    pub source: String,
    pub at_ns: u64,
}
/// Share of every NEAR rod repair paid into this week's tournament pot.
pub const REPAIR_POT_BPS: u128 = 1_500;
/// Legendary Rod requirements beyond its recipe.
pub const LEGENDARY_MIN_TROPHIES: u64 = 1;
pub const LEGENDARY_MIN_TUNA_G: u64 = 30_000;
/// Most standing orders one NPC may hold at once.
pub const MAX_ORDERS_PER_NPC: usize = 4;

/// Bait quality: a zone that needs tier N accepts any bait of tier N or more.
pub fn bait_tier(item: &str) -> u8 {
    match item {
        "guppy" => 1,
        "tilapia" => 2,
        _ => 0,
    }
}

/// Rods, by id: (tier, price in NEAR, crafting recipe). Owning several is
/// fine; the player picks which one to fish with. Tier gates the zones.
pub struct RodSpec {
    pub id: &'static str,
    pub bit: u8,
    pub tier: u8,
    /// Buy price; 0 means craft-only.
    pub price: u128,
    /// Crafting recipe; empty means buy-only.
    pub recipe: &'static [(&'static str, u64)],
    /// Wear points before the rod breaks. A fish costs 1, tuna and koi 3.
    pub durability: u32,
    /// Repair price in NEAR, or the fish burned to repair it instead.
    pub repair: u128,
    pub repair_recipe: &'static [(&'static str, u64)],
}
const MILLI: u128 = ONE_NEAR / 1_000;
pub const RODS: [RodSpec; 6] = [
    RodSpec { id: "bamboo", bit: 5, tier: 0, price: 100 * MILLI, recipe: &[], durability: 100,
              repair: 30 * MILLI, repair_recipe: &[("guppy", 8)] },
    RodSpec { id: "carbon", bit: 1, tier: 1, price: 1_500 * MILLI, recipe: &[("snapper", 12)], durability: 200,
              repair: 450 * MILLI, repair_recipe: &[("snapper", 5)] },
    RodSpec { id: "spinner", bit: 2, tier: 1, price: 1_500 * MILLI, recipe: &[("snapper", 8), ("tilapia", 5)], durability: 150,
              repair: 450 * MILLI, repair_recipe: &[("snapper", 3), ("tilapia", 3)] },
    RodSpec { id: "master", bit: 3, tier: 2, price: 6 * ONE_NEAR, recipe: &[("snapper", 25), ("tuna", 3)], durability: 250,
              repair: 1_800 * MILLI, repair_recipe: &[("snapper", 8), ("tuna", 1)] },
    RodSpec { id: "harpoon", bit: 4, tier: 2, price: 6 * ONE_NEAR, recipe: &[("tuna", 4), ("koi", 1)], durability: 200,
              repair: 1_800 * MILLI, repair_recipe: &[("tuna", 2)] },
    RodSpec { id: "legendary", bit: 6, tier: 2, price: 0, recipe: &[("tuna", 5), ("koi", 2)], durability: 600,
              repair: 3 * ONE_NEAR, repair_recipe: &[("tuna", 3), ("koi", 1)] },
];
/// Wear a landed fish puts on the rod that caught it.
pub fn wear_of(item: &str) -> u32 {
    match item {
        "tuna" | "koi" => 3,
        _ => 1,
    }
}

/// One owned rod and how much life it has left.
#[near(serializers = [json])]
pub struct RodStatus {
    pub id: String,
    pub left: u32,
    pub durability: u32,
}
/// Crew: players who back a harbor master's stake share its earnings.
pub const MAX_CREW: usize = 20;
pub const MIN_CREW_STAKE: u128 = ONE_NEAR / 10;

#[near(serializers = [json])]
pub struct SeasonView {
    pub week: u64,
    pub id: u8,
    pub name: String,
    pub ends_ns: u64,
}

/// A standing NPC order: the NPC pays `price` per unit for `item_id`, from
/// NEAR locked in escrow when the order was posted.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Order {
    pub npc_id: String,
    pub item_id: String,
    pub units_left: u64,
    /// Price per unit, scaled (see PRICE_SCALE).
    pub price: u128,
    pub week: u64,
    /// yoctoNEAR held for the units still open.
    pub escrow: u128,
}

/// Everything public the game screens show, in one view call. The UI polls
/// this instead of a dozen separate views, which keeps public RPC load low.
#[near(serializers = [json])]
pub struct WorldState {
    pub items: Vec<ItemView>,
    pub npcs: Vec<Npc>,
    pub zones: Vec<ZoneView>,
    pub docks: Vec<(String, u64)>,
    pub crews: Vec<(String, Vec<(AccountId, U128)>)>,
    pub orders: Vec<Order>,
    pub listings: Vec<(u64, Listing)>,
    pub trades: Vec<TradeRecord>,
    pub season: SeasonView,
    pub tournament: TournamentView,
    pub last_tournament: TournamentView,
    pub records: Vec<(String, u64, AccountId)>,
    pub leaderboards: (Vec<(AccountId, u64)>, Vec<(AccountId, u64)>),
    pub vault: U128,
    pub solvency: Solvency,
    pub notes: Vec<NpcNote>,
    pub supply: Vec<SupplyView>,
}

/// Everything about one player, in one view call.
#[near(serializers = [json])]
pub struct PlayerState {
    pub holdings: Vec<(String, u64)>,
    pub bests: Vec<(String, u64)>,
    pub rod: u8,
    pub rods: Vec<String>,
    pub rod_status: Vec<RodStatus>,
    pub catches_left: u64,
    pub trophies: u64,
    pub releases: u64,
    pub discount_bps: u128,
    pub entered_this_week: bool,
    pub fishdex: FishdexView,
}

#[near(serializers = [json])]
pub struct FishdexView {
    pub caught: Vec<String>,
    pub complete: bool,
}

/// A weekly tournament as the UI sees it.
#[near(serializers = [json])]
pub struct TournamentView {
    pub week: u64,
    pub ends_ns: u64,
    pub pot: U128,
    pub entrants: u64,
    pub settled: bool,
    /// (zone, weight in grams, holder, fish) for each zone with a leader.
    pub leaders: Vec<(String, u64, AccountId, String)>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Zone {
    pub id: String,
    pub name: String,
    /// Most fish the zone can hold.
    pub capacity: u64,
    /// Fish currently in the zone.
    pub population: u64,
    /// Fish the zone regrows per hour (doubled while closed).
    pub regen_per_hour: u64,
    pub last_regen_ns: u64,
    /// License per fish at full health, in yoctoNEAR.
    pub base_fee: u128,
    /// Minimum rod tier needed to fish here.
    pub min_rod: u8,
    /// Steward's fee multiplier in bps (5_000..=20_000).
    pub fee_bps: u128,
    /// Closed by its steward: no catches, faster regrowth.
    pub closed: bool,
    pub steward: Option<AccountId>,
    pub steward_stake: u128,
    pub steward_earned: u128,
    pub steward_since_ns: u64,
    pub total_caught: u64,
    pub license_collected: u128,
}

impl Zone {
    fn regen(&mut self, now_ns: u64, factor_bps: u128) {
        let base = if self.closed { self.regen_per_hour * 2 } else { self.regen_per_hour } as u128;
        let rate = base * factor_bps / BPS;
        if rate == 0 || self.population >= self.capacity {
            self.last_regen_ns = now_ns;
            return;
        }
        let elapsed = now_ns.saturating_sub(self.last_regen_ns) as u128;
        let grown = (elapsed * rate / HOUR_NS) as u64;
        // Only move the clock when at least one fish grew, so frequent
        // calls do not round regrowth away.
        if grown > 0 {
            self.population = (self.population + grown).min(self.capacity);
            self.last_regen_ns = now_ns;
        }
    }

    pub fn health_bps(&self) -> u128 {
        if self.capacity == 0 { 0 } else { self.population as u128 * BPS / self.capacity as u128 }
    }

    /// License for the next fish, in yoctoNEAR. Rises as the zone empties.
    pub fn fee_per_fish(&self) -> u128 {
        let scarcity = if self.population == 0 {
            MAX_SCARCITY_BPS
        } else {
            (self.capacity as u128 * BPS / self.population as u128).clamp(BPS, MAX_SCARCITY_BPS)
        };
        self.base_fee * self.fee_bps / BPS * scarcity / BPS
    }
}

/// A zone as the UI sees it: state plus the live fee and health.
#[near(serializers = [json])]
pub struct ZoneView {
    pub zone: Zone,
    pub health_bps: u128,
    pub fee_per_fish: U128,
}

/// Rod tiers from before rods were a set of owned items. The old `rods` map
/// still holds them for early players; `rod_bits` maps them onto carbon and
/// master. New rods are bought or crafted with `acquire_rod`.
pub const ROD_WOODEN: u8 = 0;
pub const ROD_CARBON: u8 = 1;
pub const ROD_MASTER: u8 = 2;

/// Fee to record a catch, in NEAR.
///
/// Without this the economy is a faucet: catch is free, so a player can mint
/// units at will and sell them to NPCs for NEAR the NPCs never earned back.
/// The fee is the sink that makes supply cost something, and it funds the
/// vault the NPCs trade against.
pub const CATCH_FEE_NEAR: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR

/// How far a buyer may overpay above fair price, in bps. A buyer offering
/// more than this is either mistaken or manipulating; either way the trade
/// is refused rather than silently repriced.
pub const MAX_OVERPAY_BPS: u128 = 2_000; // 20%

/// How far a seller may undercut below fair price, in bps.
pub const MAX_UNDERCUT_BPS: u128 = 3_000; // 30%

/// Cooldown before an investor may withdraw principal, in seconds. Stops the
/// invest-and-immediately-pull round trip that would otherwise let a player
/// farm volume without risk.
pub const INVESTOR_COOLDOWN_SECONDS: u64 = 86_400;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Items,
    Npcs,
    Listings,
    ListingIndex { seller: AccountId },
    Investors,
    InvestorsOf { npc: String },
    TradeLog,
    PlayerHoldings,
    UsedNonces,
    Rods,
    DailyCatch,
    Zones,
    GlobalNonces,
    ZoneBait,
    BaitBurned,
    PersonalBest,
    Records,
    Trophies,
    Releases,
    TourneyEntrants,
    TourneyPot,
    TourneyLeader,
    TourneySettled,
    Docks,
    Orders,
    Fishdex,
    Crew,
    RodSet,
    RodWear,
    NpcNotes,
    Burned,
}

/// How rare an item is. Rarity is not cosmetic: it sets the base price, and
/// NPCs pay a premium for tiers they have a use for.
///
/// Stored as a plain u8 rather than a Borsh enum: an enum's wire format is its
/// discriminant, and a u8 says the same thing without the derive edge cases.
pub type Rarity = u8;

pub const RARITY_COMMON: Rarity = 0;
pub const RARITY_UNCOMMON: Rarity = 1;
pub const RARITY_RARE: Rarity = 2;
pub const RARITY_EPIC: Rarity = 3;
pub const RARITY_LEGENDARY: Rarity = 4;

/// Price multiplier in bps. A legendary fish is worth 60x a common one before
/// any market movement, so selling a legendary at a common price is never the
/// right trade.
pub fn rarity_price_bps(rarity: Rarity) -> u128 {
    match rarity {
        RARITY_COMMON => 1_000,
        RARITY_UNCOMMON => 3_000,
        RARITY_RARE => 10_000,
        RARITY_EPIC => 30_000,
        RARITY_LEGENDARY => 60_000,
        _ => 1_000,
    }
}

pub fn rarity_label(rarity: Rarity) -> &'static str {
    match rarity {
        RARITY_COMMON => "common",
        RARITY_UNCOMMON => "uncommon",
        RARITY_RARE => "rare",
        RARITY_EPIC => "epic",
        RARITY_LEGENDARY => "legendary",
        _ => "unknown",
    }
}

/// What an NPC wants an item for. This is the utility that makes a rare fish
/// worth more than its rarity alone: a chef pays for tuna, a collector pays
/// for koi, and neither pays a premium for the other's taste.
pub type Utility = u8;

pub const UTILITY_FOOD: Utility = 0;
pub const UTILITY_COLLECTIBLE: Utility = 1;
pub const UTILITY_MATERIAL: Utility = 2;
pub const UTILITY_TROPHY: Utility = 3;

pub fn utility_label(utility: Utility) -> &'static str {
    match utility {
        UTILITY_FOOD => "food",
        UTILITY_COLLECTIBLE => "collectible",
        UTILITY_MATERIAL => "material",
        UTILITY_TROPHY => "trophy",
        _ => "unknown",
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Item {
    /// Short identifier, e.g. "guppy".
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// Baseline price in scaled units (see PRICE_SCALE).
    pub base_price: u128,
    /// Rarity tier. Sets the base price multiplier.
    pub rarity: Rarity,
    /// What NPCs want it for. Drives which NPCs bid.
    pub utility: Utility,
    /// Units currently listed for sale by players.
    pub listed_supply: u64,
    /// Units bought by NPCs inside the pricing window.
    pub npc_buy_volume: u64,
    /// Units sold by NPCs inside the pricing window.
    pub npc_sell_volume: u64,
    /// Units bought *from NPCs by players* inside the pricing window.
    ///
    /// This is the only real demand signal: it is a player choosing to spend
    /// NEAR. NPC-to-NPC volume is not demand, it is inventory moving around,
    /// and treating it as demand lets an NPC justify buying stock it can
    /// never sell.
    pub player_buy_volume: u64,
    /// Units sold straight to the market vault inside the pricing window.
    /// Counted as supply so a vault sale moves the price, and reset with the
    /// window so it cannot depress the price forever.
    pub vault_intake: u64,
    /// Active event multiplier in bps. 10_000 = neutral.
    pub event_modifier_bps: u128,
    /// Label for the active event, for UI.
    pub event_label: String,
    /// Timestamp of the last pricing-window reset.
    pub window_start_ns: u64,
    /// Total units ever minted into the economy.
    pub total_minted: u64,
}

impl Item {
    /// The deterministic fair price, in scaled units.
    ///
    /// This is the whole pricing mechanism. Every input is an on-chain
    /// counter; there is no discretion anywhere in the function.
    /// Fair price with an explicit supply figure, used when the caller needs
    /// the price *as it will be* after a pending change.
    fn fair_price_with_supply(&self, npc_inventory_units: u64, supply: u64) -> u128 {
        let mut projected = self.clone();
        projected.listed_supply = supply;
        projected.fair_price(npc_inventory_units)
    }

    fn fair_price(&self, npc_inventory_units: u64) -> u128 {
        // Demand: NPC buying pushes price up.
        let demand_bps = BPS.saturating_add(
            (self.npc_buy_volume as u128 * DEMAND_WEIGHT_BPS) / DEMAND_REFERENCE,
        );
        let demand_bps = demand_bps.min(MAX_FACTOR_BPS);

        // Supply: player listings push price down.
        let supply_units = self.listed_supply.saturating_add(self.vault_intake);
        let supply_bps = BPS.saturating_sub(
            (supply_units as u128 * SUPPLY_WEIGHT_BPS) / SUPPLY_REFERENCE,
        );
        let supply_bps = supply_bps.max(MIN_FACTOR_BPS);

        // Scarcity: total NPC stock pushes price down.
        let scarcity_bps = BPS.saturating_sub(
            (npc_inventory_units as u128 * SCARCITY_WEIGHT_BPS) / SCARCITY_REFERENCE,
        );
        let scarcity_bps = scarcity_bps.max(MIN_FACTOR_BPS);

        // Compose: base * rarity * demand * supply * scarcity * event, all in
        // bps. Rarity is applied first so the market factors move a legendary
        // fish around its own (high) baseline, not a common one.
        let scaled = self
            .base_price
            .saturating_mul(rarity_price_bps(self.rarity))
            / BPS;
        let scaled = scaled.saturating_mul(demand_bps) / BPS;
        let scaled = scaled.saturating_mul(supply_bps) / BPS;
        let scaled = scaled.saturating_mul(scarcity_bps) / BPS;
        let scaled = scaled.saturating_mul(self.event_modifier_bps) / BPS;

        // Floor at 1 scaled unit so a price can never reach zero and stall
        // the economy entirely.
        scaled.max(1)
    }
}

/// One lot of inventory, carrying its cost basis for FIFO accounting.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Lot {
    pub item_id: String,
    pub units: u64,
    /// Cost per unit in scaled units.
    pub unit_cost: u128,
}

/// An NPC: a named economic actor with a real treasury and a personality.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Npc {
    pub id: String,
    pub name: String,
    /// Treasury in yoctoNEAR. Real money, tracked here.
    pub treasury: u128,
    /// Inventory as FIFO lots.
    pub inventory: Vec<Lot>,
    /// Cumulative realized profit in scaled units (can be negative).
    pub realized_profit: i128,
    /// Total units traded, for stats.
    pub trades: u64,
    /// Trades inside the current rate-limit window.
    pub window_trades: u64,
    /// Start of the current rate-limit window.
    pub window_start_ns: u64,
    /// Public keys this contract has issued as function-call keys for this
    /// NPC. An NPC key that is not on this list was never scoped by us and
    /// is a bypass path.
    pub agent_keys: Vec<String>,
    /// Standing asks: (item, price per unit in scaled units). A player buying
    /// from this NPC pays the NPC's ask, never a price the buyer picked.
    pub asks: Vec<(String, u128)>,
    /// Total investor principal currently in this NPC, in yoctoNEAR. Profit
    /// shares are pro rata against it, so the shares can never sum past 30%.
    pub invested_total: u128,

    // --- personality parameters ---
    // These are the only things that differ between Bob, Alice and John.
    // They are constants stored on-chain; the AI never sets them.

    /// How far above fair price this NPC will still buy, in bps.
    pub buy_tolerance_bps: u128,
    /// How far below fair price this NPC will still sell, in bps.
    pub sell_tolerance_bps: u128,
    /// Fraction of treasury this NPC will deploy in one trade, in bps.
    pub aggression_bps: u128,
    /// Fraction of treasury held back as reserve, in bps.
    pub reserve_bps: u128,
    /// Minimum edge required before acting, in bps.
    pub min_edge_bps: u128,
}

impl Npc {
    /// The NPC's standing ask for an item, if it has posted one.
    pub fn ask_of(&self, item_id: &str) -> Option<u128> {
        self.asks.iter().find(|(i, _)| i == item_id).map(|(_, p)| *p)
    }

    fn set_ask(&mut self, item_id: &str, price: u128) {
        if let Some(entry) = self.asks.iter_mut().find(|(i, _)| i == item_id) {
            entry.1 = price;
        } else {
            self.asks.push((item_id.to_string(), price));
        }
    }

    /// Units of `item_id` currently held.
    pub fn units_of(&self, item_id: &str) -> u64 {
        self.inventory
            .iter()
            .filter(|l| l.item_id == item_id)
            .map(|l| l.units)
            .sum()
    }

    /// Total cost basis of `item_id`, in scaled units.
    fn cost_basis_of(&self, item_id: &str) -> u128 {
        self.inventory
            .iter()
            .filter(|l| l.item_id == item_id)
            .map(|l| l.units as u128 * l.unit_cost)
            .sum()
    }

    /// Average cost per unit of `item_id`, or 0 when holding none.
    pub fn avg_cost_of(&self, item_id: &str) -> u128 {
        let units = self.units_of(item_id);
        if units == 0 {
            return 0;
        }
        self.cost_basis_of(item_id) / units as u128
    }

    /// Consume `units` of `item_id` FIFO, returning the cost basis consumed
    /// and the realized profit at `sale_price_per_unit`.
    ///
    /// Realized profit is `sold_for - paid_for`, never a mark-to-market gain.
    fn consume_fifo(&mut self, item_id: &str, units: u64, sale_price: u128) -> u128 {
        let mut remaining = units;
        let mut cost = 0u128;
        while remaining > 0 {
            let idx = match self.inventory.iter().position(|l| l.item_id == item_id) {
                Some(i) => i,
                None => break,
            };
            let take = remaining.min(self.inventory[idx].units);
            cost += take as u128 * self.inventory[idx].unit_cost;
            self.inventory[idx].units -= take;
            if self.inventory[idx].units == 0 {
                self.inventory.remove(idx);
            }
            remaining -= take;
        }
        let revenue = units as u128 * sale_price;
        let profit = revenue as i128 - cost as i128;
        self.realized_profit += profit;
        cost
    }

    /// Add units at a given unit cost, merging into the last lot when the
    /// cost matches so inventory does not fragment.
    fn add_units(&mut self, item_id: &str, units: u64, unit_cost: u128) {
        if let Some(last) = self.inventory.last_mut() {
            if last.item_id == item_id && last.unit_cost == unit_cost {
                last.units += units;
                return;
            }
        }
        self.inventory.push(Lot {
            item_id: item_id.to_string(),
            units,
            unit_cost,
        });
    }
}

/// A player's open sell order.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Listing {
    pub seller: AccountId,
    pub item_id: String,
    pub units: u64,
    /// Ask price per unit, in scaled units.
    pub ask_price: u128,
    /// Fair price at the moment the listing was created, in scaled units.
    ///
    /// The overpay band is checked against this snapshot, not against the
    /// live fair price. Otherwise a listing created when supply was low
    /// becomes un-buyable the moment other listings push the price down —
    /// the market would deadlock against itself.
    pub fair_at_list: u128,
    pub created_ns: u64,
    pub active: bool,
}

/// An investor's stake in one NPC.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Investment {
    /// Principal in yoctoNEAR.
    pub principal: u128,
    /// Share of realized profit in bps.
    pub share_bps: u128,
    /// NPC realized profit at the moment of investment. Profit earned before
    /// this snapshot is not the investor's.
    pub entry_profit: i128,
    /// When the principal may be withdrawn.
    pub unlock_ns: u64,
    /// Profit already paid out, in scaled units.
    pub claimed: i128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    items: UnorderedMap<String, Item>,
    npcs: UnorderedMap<String, Npc>,
    listings: Vector<Listing>,
    /// NPC id -> investor account -> investment.
    investors: LookupMap<String, LookupMap<AccountId, Investment>>,
    /// (player, item) -> units held. Flat rather than nested: a nested
    /// LookupMap needs the same storage prefix on every read and write, and
    /// getting that wrong silently loses data. A tuple key cannot.
    player_holdings: LookupMap<(AccountId, String), u64>,
    /// Account whose signature authorises a catch. The mini-game runs
    /// off-chain (a cast costs no gas), so the client reports the result and
    /// this account vouches for it. Without it anyone could mint units by
    /// calling claim_catches with a made-up receipt.
    game_signer: AccountId,
    /// The signer's public key, so the contract can verify a catch signature
    /// without an extra cross-contract call.
    game_signer_public_key: String,
    /// (player, nonce) pairs already claimed. Stops a captured signature
    /// from being replayed to mint units again.
    used_nonces: UnorderedSet<(AccountId, u64)>,
    /// Best rod tier each player owns.
    rods: LookupMap<AccountId, u8>,
    /// player -> (UTC day number, fish claimed that day).
    daily_catch: LookupMap<AccountId, (u64, u64)>,
    /// Append-only trade log, for the UI and for auditability.
    trade_log: Vector<TradeRecord>,
    /// NEAR owned by the market vault, in yoctoNEAR. The vault pays players
    /// who sell straight to the market, and it can only pay out what was put
    /// in (catch fees and explicit funding). It never touches NPC treasuries.
    vault_balance: u128,
}

/// What the contract owes against what it holds. `balance` must always cover
/// `liabilities + storage`; if it does not, the economy is insolvent.
#[near(serializers = [json])]
pub struct Solvency {
    pub balance: U128,
    pub liabilities: U128,
    pub storage: U128,
    pub npc_treasuries: U128,
    pub vault: U128,
    pub stewards: U128,
    pub tournaments: U128,
    pub order_escrow: U128,
    pub solvent: bool,
}

/// One signed single-catch receipt from the game server.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CatchReceipt {
    /// The zone the fish came out of. Signed, so it cannot be swapped.
    pub zone_id: String,
    pub item_id: String,
    pub units: u64,
    pub nonce: u64,
    /// Weight of the fish in grams, decided and signed by the game server.
    pub weight_g: u64,
    /// Taken from a closed zone. Signed, so a poacher cannot drop the flag.
    #[serde(default)]
    pub poached: bool,
    /// The bait used for this catch, if any. Signed, so it is burned.
    #[serde(default)]
    pub bait: Option<String>,
    /// The rod that caught it, if the receipt names one. Signed; it wears.
    #[serde(default)]
    pub rod: Option<String>,
    pub signature: String,
}

/// An item with its computed fair price, so a UI can render the market in one
/// call without reimplementing the pricing function.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ItemView {
    pub id: String,
    pub name: String,
    pub base_price: u128,
    pub fair_price: u128,
    /// Rarity tier, so the UI can show it and buyers can filter on it.
    pub rarity: Rarity,
    /// What NPCs want it for.
    pub utility: Utility,
    pub listed_supply: u64,
    pub npc_buy_volume: u64,
    pub npc_sell_volume: u64,
    /// Units players bought from NPCs — real demand, not inventory churn.
    pub player_buy_volume: u64,
    pub npc_inventory: u64,
    pub event_modifier_bps: u128,
    pub event_label: String,
}

/// One settled trade. The audit trail that makes the economy verifiable.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct TradeRecord {
    pub kind: String, // "npc_buy" | "npc_sell" | "player_buy"
    pub npc_id: String,
    pub counterparty: AccountId,
    pub item_id: String,
    pub units: u64,
    /// Price per unit actually paid, in scaled units.
    pub price: u128,
    /// Fair price at the moment of settlement, in scaled units.
    pub fair_price: u128,
    pub at_ns: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, game_signer: AccountId) -> Self {
        require!(!env::state_exists(), "already initialised");
        Self {
            owner,
            items: UnorderedMap::new(StorageKey::Items),
            npcs: UnorderedMap::new(StorageKey::Npcs),
            listings: Vector::new(StorageKey::Listings),
            investors: LookupMap::new(StorageKey::Investors),
            trade_log: Vector::new(StorageKey::TradeLog),
            player_holdings: LookupMap::new(StorageKey::PlayerHoldings),
            used_nonces: UnorderedSet::new(StorageKey::UsedNonces),
            rods: LookupMap::new(StorageKey::Rods),
            daily_catch: LookupMap::new(StorageKey::DailyCatch),
            game_signer,
            game_signer_public_key: String::new(),
            vault_balance: 0,
        }
    }

    // ------------------------------------------------------------- owner setup

    pub fn owner(&self) -> &AccountId {
        &self.owner
    }

    /// Register a tradeable item.
    pub fn register_item(
        &mut self,
        id: String,
        name: String,
        base_price: U128,
        rarity: Rarity,
        utility: Utility,
    ) {
        self.require_owner();
        require!(self.items.len() < MAX_ITEMS as u64, "too many items");
        require!(!self.items.get(&id).is_some(), "item already exists");
        self.items.insert(
            &id,
            &Item {
                id: id.clone(),
                name,
                base_price: base_price.0,
                rarity,
                utility,
                listed_supply: 0,
                npc_buy_volume: 0,
                npc_sell_volume: 0,
                player_buy_volume: 0,
                vault_intake: 0,
                event_modifier_bps: BPS,
                event_label: "normal".to_string(),
                window_start_ns: env::block_timestamp(),
                total_minted: 0,
            },
        );
    }

    /// Register an NPC with a treasury and a personality.
    ///
    /// `treasury` is transferred from the caller into the NPC's balance, so
    /// an NPC starts with real money and can never have more than was put in
    /// or earned.
    #[payable]
    pub fn register_npc(
        &mut self,
        id: String,
        name: String,
        treasury: U128,
        personality: Personality,
    ) {
        self.require_owner();
        // The caller funds the treasury by attaching it. Without this the
        // NPC is registered with a treasury it does not actually hold.
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(treasury.0),
            "attach the NPC's starting treasury"
        );
        require!(self.npcs.len() < MAX_NPCS as u64, "too many npcs");
        require!(!self.npcs.get(&id).is_some(), "npc already exists");
        require!(treasury.0 > 0, "npc needs a starting treasury");

        let npc = Npc {
            id: id.clone(),
            name,
            treasury: treasury.0,
            inventory: vec![],
            realized_profit: 0,
            trades: 0,
            window_trades: 0,
            window_start_ns: env::block_timestamp(),
            agent_keys: vec![],
            asks: vec![],
            invested_total: 0,
            buy_tolerance_bps: personality.buy_tolerance_bps,
            sell_tolerance_bps: personality.sell_tolerance_bps,
            aggression_bps: personality.aggression_bps,
            reserve_bps: personality.reserve_bps,
            min_edge_bps: personality.min_edge_bps,
        };
        self.npcs.insert(&id, &npc);

        // The treasury is real: the caller attached it as a deposit, and it
        // stays in the contract's balance — the contract now owes it to the
        // NPC. Refunding it here would leave every NPC with a treasury of
        // zero and no ability to trade at all.
    }

    /// Set an event modifier on an item. This is the only "shock" lever, and
    /// it is owner-only and bounded.
    pub fn set_event(&mut self, item_id: String, modifier_bps: U128, label: String) {
        self.require_owner();
        let mut item = self
            .items
            .get(&item_id)
            .unwrap_or_else(|| env::panic_str("unknown item"));
        require!(
            modifier_bps.0 >= MIN_FACTOR_BPS && modifier_bps.0 <= MAX_FACTOR_BPS,
            "event modifier out of bounds"
        );
        item.event_modifier_bps = modifier_bps.0;
        item.event_label = label;
        self.items.insert(&item_id, &item);
    }

    // ------------------------------------------------------- agent key management

    /// Issue a function-call access key for an NPC, scoped to this contract.
    ///
    /// **This is the step that makes the whole design safe.** Without it the
    /// NPC holds a full-access key: anyone who steals it can drain the NPC's
    /// sub-account directly, bypassing every check in this contract.
    ///
    /// The key is issued with a receiver of this contract only and a method
    /// allowlist of the NPC-facing entry points. The owner signs this call,
    /// so the owner's key must be the one present on the NPC sub-account.
    ///
    /// `allowance` is the NEAR gas budget for the key, in yoctoNEAR. Pass
    /// `None` for an unlimited gas allowance, which is the right default for
    /// an NPC that trades regularly.
    pub fn issue_agent_key(
        &mut self,
        npc_id: String,
        public_key: String,
        allowance: Option<U128>,
    ) {
        self.require_owner();
        let key = npc_id.clone();
        let mut npc = self
            .npcs
            .get(&key)
            .unwrap_or_else(|| env::panic_str("unknown npc"));
        require!(
            !npc.agent_keys.contains(&public_key),
            "key already issued for this npc"
        );
        npc.agent_keys.push(public_key.clone());
        self.npcs.insert(&key, &npc);

        // The sub-account that will hold the key.
        let sub = npc_id_as_account(&npc_id);
        let pk: PublicKey = public_key
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid public key"));

        let allowance_tokens = match allowance {
            Some(a) => NearToken::from_yoctonear(a.0),
            None => NearToken::from_yoctonear(0),
        };

        // The method list is the security boundary. An NPC key that could
        // call anything else on this contract could, for example, edit its
        // own policy. Only the trade entry points are exposed.
        let _ = Promise::new(sub).add_access_key_allowance(
            pk,
            near_sdk::Allowance::Limited(
                std::num::NonZeroU128::new(allowance_tokens.as_yoctonear())
                    .unwrap_or(std::num::NonZeroU128::new(1).unwrap()),
            ),
            env::current_account_id(),
            "npc_buy,npc_sell,check,window_spend,window_budget_remaining,recent_spend,get_npc,get_policy,is_enabled",
        );
    }

    /// Revoke an NPC's access key.
    pub fn revoke_agent_key(&mut self, npc_id: String, public_key: String) {
        self.require_owner();
        let key = npc_id.clone();
        let mut npc = self
            .npcs
            .get(&key)
            .unwrap_or_else(|| env::panic_str("unknown npc"));
        require!(
            npc.agent_keys.contains(&public_key),
            "key was not issued by this contract"
        );
        npc.agent_keys.retain(|k| k != &public_key);
        self.npcs.insert(&key, &npc);

        let sub = npc_id_as_account(&npc_id);
        let pk: PublicKey = public_key
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid public key"));
        let _ = Promise::new(sub).delete_key(pk);
    }

    /// List the function-call keys this contract has issued for an NPC.
    ///
    /// An operator should compare this against `near keys <npc-subaccount>`:
    /// any full-access key on that account is a bypass path regardless of
    /// what this list says.
    pub fn agent_keys(&self, npc_id: String) -> Vec<String> {
        let key = npc_id.clone();
        self.npcs
            .get(&key)
            .map(|n| n.agent_keys)
            .unwrap_or_default()
    }

    // ------------------------------------------------------------ player side

    /// Claim a batch of single-fish receipts in one transaction.
    ///
    /// The game server signs every catch the moment it happens, one receipt
    /// per fish with its own nonce. The client collects them and claims them
    /// together. Each fish comes out of its zone's population and pays that
    /// zone's license at the moment it is landed, so a big haul from a thin
    /// zone costs more per fish than a small one from a healthy zone.
    ///
    /// Attach at least `claim_quote` (catch fee + licenses); any excess is
    /// refunded.
    #[payable]
    pub fn claim_catches(&mut self, receipts: Vec<CatchReceipt>) {
        require!(!receipts.is_empty(), "no receipts");
        require!(receipts.len() <= MAX_RECEIPTS_PER_CLAIM, "too many receipts in one claim");
        let player = env::predecessor_account_id();
        let key_bytes = Self::decode_ed25519(&self.game_signer_public_key, "game signer key not set");
        let key: [u8; 32] = key_bytes
            .try_into()
            .unwrap_or_else(|_| env::panic_str("game signer key must be 32 bytes"));
        let now = env::block_timestamp();
        let mut zones = Self::zones_map();
        let baits = Self::bait_map();
        let mut touched: Vec<Zone> = Vec::new();
        let mut license_total: u128 = 0;
        let mut to_vault: u128 = CATCH_FEE_NEAR;
        let discount = self.trophy_discount_bps(&player);
        let week = now / WEEK_NS;
        let entered = Self::entrants_map().get(&(week, player.clone())).is_some();

        for r in receipts.iter() {
            require!(r.units >= 1 && r.units <= MAX_CATCH_UNITS, "bad receipt size");
            let mut item = self
                .items
                .get(&r.item_id)
                .unwrap_or_else(|| env::panic_str("unknown item"));
            let mut message = format!(
                "catch:{}:{}:{}:{}:{}:{}:{}",
                env::current_account_id(),
                player,
                r.zone_id,
                r.item_id,
                r.units,
                r.nonce,
                r.weight_g
            );
            // Only poached receipts carry the tag, so honest receipts keep
            // the format they always had.
            if r.poached {
                message.push_str(":poached");
            }
            if let Some(b) = &r.bait {
                message.push_str(":bait:");
                message.push_str(b);
            }
            if let Some(rod) = &r.rod {
                message.push_str(":rod:");
                message.push_str(rod);
            }
            let sig_bytes = Self::decode_ed25519(&r.signature, "malformed signature");
            let sig: [u8; 64] = sig_bytes
                .try_into()
                .unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"));
            require!(
                env::ed25519_verify(&sig, message.as_bytes(), &key),
                "catch is not signed by the game server"
            );
            require!(
                !self.used_nonces.contains(&(player.clone(), r.nonce)),
                "this catch has already been claimed"
            );
            self.used_nonces.insert(&(player.clone(), r.nonce));
            // A guest's catch can be adopted by whichever account connects
            // first, so a nonce must be spent once across *all* players, or
            // one guest ticket could be cashed by several accounts.
            let mut spent: LookupMap<u64, bool> = LookupMap::new(StorageKey::GlobalNonces);
            require!(spent.get(&r.nonce).is_none(), "this catch has already been claimed");
            spent.insert(&r.nonce, &true);

            // Deep zones need live bait: one bait fish per fish landed, burned
            // here. Bait caught earlier in this same claim already counts,
            // because each receipt's fish lands in holdings before the next.
            // A zone's bait is a minimum tier; better bait is always
            // accepted. Receipts from before bait was chosen burn the zone's.
            let required = baits.get(&r.zone_id);
            let used = r.bait.clone().or_else(|| required.clone());
            if let Some(req) = &required {
                let ok = used.as_ref().map(|u| bait_tier(u) >= bait_tier(req)).unwrap_or(false);
                if !ok {
                    env::panic_str(&format!("fish from {} need {} or better as bait", r.zone_id, req));
                }
            }
            if let Some(bait) = used {
                require!(bait_tier(&bait) > 0, "that is not bait");
                let bk = (player.clone(), bait.clone());
                let have = self.player_holdings.get(&bk).unwrap_or(0);
                if have < r.units {
                    env::panic_str(&format!("each fish caught with {} bait burns one {}", bait, bait));
                }
                self.player_holdings.insert(&bk, &(have - r.units));
                let burned = Self::bait_burned_map().get(&bait).unwrap_or(0);
                Self::bait_burned_map().insert(&bait, &(burned + r.units));
            }

            // The fish leaves the zone and pays its license now.
            let pos = touched.iter().position(|z| z.id == r.zone_id);
            let mut zone = match pos {
                Some(p) => touched.remove(p),
                None => {
                    let mut z = zones.get(&r.zone_id).unwrap_or_else(|| env::panic_str("unknown zone"));
                    let f = self.regen_factor(&z.id);
                    z.regen(now, f);
                    z
                }
            };
            // A closed zone can still be fished, but only as a poacher.
            require!(!zone.closed || r.poached, "this zone is closed by its harbor master");
            for _ in 0..r.units {
                require!(zone.population > 0, "the zone is fished out, let it recover");
                // Mounted koi trophies earn their owner a license discount.
                let fee = zone.fee_per_fish() * (BPS - discount) / BPS;
                zone.population -= 1;
                zone.total_caught += 1;
                if r.poached {
                    // The fine: three licenses, every yocto to the harbor
                    // master whose closed zone was raided.
                    let fine = fee * POACH_FINE_MULTIPLIER;
                    zone.license_collected += fine;
                    license_total += fine;
                    if zone.steward.is_some() {
                        zone.steward_earned += fine;
                    } else {
                        to_vault += fine;
                    }
                    continue;
                }
                zone.license_collected += fee;
                license_total += fee;
                // The steward is paid only while the zone stays healthy.
                let share = fee * STEWARD_SHARE_BPS / BPS;
                if zone.steward.is_some() && zone.health_bps() >= STEWARD_HEALTH_BPS {
                    zone.steward_earned += share;
                    to_vault += fee - share;
                } else {
                    to_vault += fee;
                }
            }
            touched.push(zone);

            item.total_minted = item.total_minted.saturating_add(r.units);
            self.items.insert(&r.item_id, &item);
            let hk = (player.clone(), r.item_id.clone());
            let held = self.player_holdings.get(&hk).unwrap_or(0);
            self.player_holdings.insert(&hk, &(held + r.units));

            // The rod wears with every fish it lands. A rod at zero still
            // brings this catch home; it just cannot be cast again until
            // it is repaired.
            if let Some(rod) = &r.rod {
                let spec = RODS.iter().find(|s| s.id == rod).unwrap_or_else(|| env::panic_str("unknown rod"));
                require!(self.rod_bits(&player) & (1 << spec.bit) != 0, "that rod is not yours");
                let wk = Self::wear_key(&player, spec.id);
                let mut wm = Self::rod_wear_map();
                let worn = wm.get(&wk).unwrap_or(0);
                let add = wear_of(&r.item_id).saturating_mul(r.units as u32);
                wm.insert(&wk, &worn.saturating_add(add).min(spec.durability));
            }

            self.record_weight(&player, &r.item_id, &r.zone_id, r.weight_g, if entered { Some(week) } else { None });
            self.mark_fishdex(&player, &r.item_id);
        }
        for z in touched.iter() {
            zones.insert(&z.id, z);
        }

        let due = CATCH_FEE_NEAR + license_total;
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= due, "attach the catch fee plus the zone licenses (see claim_quote)");
        let total: u64 = receipts.iter().map(|r| r.units).sum();
        self.count_daily_catch(&player, total);
        self.vault_balance += to_vault;
        if attached > due {
            let _ = Promise::new(player.clone()).transfer(NearToken::from_yoctonear(attached - due));
        }
        env::log_str(&format!(
            "claim_catches: {} claimed {} receipts, license {}",
            player,
            receipts.len(),
            license_total
        ));
    }

    /// What `claim_catches` will charge for `counts` fish per zone right now:
    /// the catch fee plus each fish's license as the zone thins out.
    pub fn claim_quote(&self, counts: Vec<(String, u64)>, player: Option<AccountId>) -> U128 {
        let now = env::block_timestamp();
        let discount = player.map(|p| self.trophy_discount_bps(&p)).unwrap_or(0);
        let zones = Self::zones_map();
        let mut total = CATCH_FEE_NEAR;
        let mut seen: Vec<Zone> = Vec::new();
        for (zid, n) in counts {
            let pos = seen.iter().position(|z| z.id == zid);
            let mut z = match pos {
                Some(p) => seen.remove(p),
                None => {
                    let mut z = zones.get(&zid).unwrap_or_else(|| env::panic_str("unknown zone"));
                    let f = self.regen_factor(&z.id);
                    z.regen(now, f);
                    z
                }
            };
            for _ in 0..n {
                if z.population == 0 { break; }
                total += z.fee_per_fish() * (BPS - discount) / BPS;
                z.population -= 1;
            }
            seen.push(z);
        }
        U128(total)
    }

    // ------------------------------------------------------------- zones

    fn zones_map() -> LookupMap<String, Zone> {
        LookupMap::new(StorageKey::Zones)
    }

    fn zone_ids() -> Vec<String> {
        env::storage_read(ZONE_IDS_KEY)
            .map(|b| Vec::<String>::try_from_slice(&b).unwrap_or_default())
            .unwrap_or_default()
    }

    fn load_zone(&self, zone_id: &str) -> Zone {
        let mut z = Self::zones_map()
            .get(&zone_id.to_string())
            .unwrap_or_else(|| env::panic_str("unknown zone"));
        let f = self.regen_factor(&z.id);
        z.regen(env::block_timestamp(), f);
        z
    }

    fn save_zone(&self, z: &Zone) {
        Self::zones_map().insert(&z.id, z);
    }

    /// Register a fishing zone. Owner-only. It starts fully stocked.
    pub fn register_zone(
        &mut self,
        id: String,
        name: String,
        capacity: u64,
        regen_per_hour: u64,
        base_fee: U128,
        min_rod: u8,
    ) {
        self.require_owner();
        require!(capacity > 0, "a zone needs capacity");
        let mut ids = Self::zone_ids();
        require!(!ids.contains(&id), "zone already exists");
        require!(ids.len() < 16, "too many zones");
        let z = Zone {
            id: id.clone(),
            name,
            capacity,
            population: capacity,
            regen_per_hour,
            last_regen_ns: env::block_timestamp(),
            base_fee: base_fee.0,
            min_rod,
            fee_bps: BPS,
            closed: false,
            steward: None,
            steward_stake: 0,
            steward_earned: 0,
            steward_since_ns: 0,
            total_caught: 0,
            license_collected: 0,
        };
        self.save_zone(&z);
        ids.push(id);
        env::storage_write(ZONE_IDS_KEY, &near_sdk::borsh::to_vec(&ids).unwrap());
    }

    /// One zone with its population regrown to now.
    pub fn get_zone(&self, zone_id: String) -> Option<ZoneView> {
        Self::zones_map().get(&zone_id).map(|mut z| {
            let f = self.regen_factor(&z.id);
            z.regen(env::block_timestamp(), f);
            ZoneView { health_bps: z.health_bps(), fee_per_fish: U128(z.fee_per_fish()), zone: z }
        })
    }

    pub fn all_zones(&self) -> Vec<ZoneView> {
        Self::zone_ids().into_iter().filter_map(|id| self.get_zone(id)).collect()
    }

    fn bait_map() -> LookupMap<String, String> {
        LookupMap::new(StorageKey::ZoneBait)
    }

    fn bait_burned_map() -> LookupMap<String, u64> {
        LookupMap::new(StorageKey::BaitBurned)
    }

    /// Set (or clear) the bait a zone requires. Owner-only.
    pub fn set_zone_bait(&mut self, zone_id: String, item_id: Option<String>) {
        self.require_owner();
        require!(Self::zones_map().get(&zone_id).is_some(), "unknown zone");
        let mut m = Self::bait_map();
        match item_id {
            Some(item) => {
                require!(self.items.get(&item).is_some(), "unknown item");
                m.insert(&zone_id, &item);
            }
            None => {
                m.remove(&zone_id);
            }
        }
    }

    /// The bait fish a zone requires per catch, if any.
    pub fn zone_bait(&self, zone_id: String) -> Option<String> {
        Self::bait_map().get(&zone_id)
    }

    /// Bait requirements for every zone: (zone, item).
    pub fn all_zone_bait(&self) -> Vec<(String, String)> {
        let m = Self::bait_map();
        Self::zone_ids().into_iter().filter_map(|z| m.get(&z).map(|b| (z, b))).collect()
    }

    /// How many of an item have been burned as bait, ever.
    pub fn bait_burned(&self, item_id: String) -> u64 {
        Self::bait_burned_map().get(&item_id).unwrap_or(0)
    }

    // ------------------------------------------------ records and trophies

    fn personal_best_map() -> LookupMap<(AccountId, String), u64> { LookupMap::new(StorageKey::PersonalBest) }
    fn records_map() -> LookupMap<String, (u64, AccountId)> { LookupMap::new(StorageKey::Records) }
    fn trophies_map() -> LookupMap<AccountId, u64> { LookupMap::new(StorageKey::Trophies) }
    fn releases_map() -> LookupMap<AccountId, u64> { LookupMap::new(StorageKey::Releases) }
    fn entrants_map() -> LookupMap<(u64, AccountId), bool> { LookupMap::new(StorageKey::TourneyEntrants) }
    fn pot_map() -> LookupMap<u64, (u128, u64)> { LookupMap::new(StorageKey::TourneyPot) }
    fn leader_map() -> LookupMap<(u64, String), (u64, AccountId, String)> { LookupMap::new(StorageKey::TourneyLeader) }
    fn settled_map() -> LookupMap<u64, bool> { LookupMap::new(StorageKey::TourneySettled) }

    fn read_u128(key: &[u8]) -> u128 {
        env::storage_read(key).map(|b| u128::try_from_slice(&b).unwrap_or(0)).unwrap_or(0)
    }
    fn write_u128(key: &[u8], v: u128) {
        env::storage_write(key, &near_sdk::borsh::to_vec(&v).unwrap());
    }
    fn read_top(key: &[u8]) -> Vec<(AccountId, u64)> {
        env::storage_read(key).map(|b| Vec::<(AccountId, u64)>::try_from_slice(&b).unwrap_or_default()).unwrap_or_default()
    }
    /// Keep a small sorted top-N list so the leaderboard is one read.
    fn bump_top(key: &[u8], who: &AccountId, score: u64) {
        let mut top = Self::read_top(key);
        top.retain(|(a, _)| a != who);
        top.push((who.clone(), score));
        top.sort_by(|a, b| b.1.cmp(&a.1));
        top.truncate(TOP_N);
        env::storage_write(key, &near_sdk::borsh::to_vec(&top).unwrap());
    }

    fn record_weight(&mut self, player: &AccountId, item: &str, zone: &str, weight: u64, week: Option<u64>) {
        let pk = (player.clone(), item.to_string());
        let mut pb = Self::personal_best_map();
        if weight > pb.get(&pk).unwrap_or(0) {
            pb.insert(&pk, &weight);
        }
        let mut rec = Self::records_map();
        if weight > rec.get(&item.to_string()).map(|(w, _)| w).unwrap_or(0) {
            rec.insert(&item.to_string(), &(weight, player.clone()));
            env::log_str(&format!("NEW RECORD: {} landed a {}g {}", player, weight, item));
        }
        if let Some(w) = week {
            let lk = (w, zone.to_string());
            let mut lm = Self::leader_map();
            if weight > lm.get(&lk).map(|(g, _, _)| g).unwrap_or(0) {
                lm.insert(&lk, &(weight, player.clone(), item.to_string()));
            }
        }
    }

    /// A player's heaviest catch of a species, in grams.
    pub fn personal_best(&self, player: AccountId, item_id: String) -> u64 {
        Self::personal_best_map().get(&(player, item_id)).unwrap_or(0)
    }

    /// The heaviest fish of each species ever landed: (item, grams, holder).
    pub fn records(&self) -> Vec<(String, u64, AccountId)> {
        let m = Self::records_map();
        self.items
            .keys()
            .filter_map(|id| m.get(&id).map(|(w, a)| (id, w, a)))
            .collect()
    }

    fn trophy_discount_bps(&self, player: &AccountId) -> u128 {
        let n = Self::trophies_map().get(player).unwrap_or(0) as u128;
        (n * TROPHY_DISCOUNT_BPS).min(MAX_TROPHY_DISCOUNT_BPS)
    }

    fn burn_one(&mut self, player: &AccountId, item: &str) {
        let hk = (player.clone(), item.to_string());
        let held = self.player_holdings.get(&hk).unwrap_or(0);
        require!(held >= 1, "you hold no koi");
        self.player_holdings.insert(&hk, &(held - 1));
    }

    /// Mount a koi as a trophy: the fish is burned for good, and every trophy
    /// takes 5% off your fishing licenses (up to 50%).
    pub fn mount_trophy(&mut self) -> u64 {
        let me = env::predecessor_account_id();
        self.burn_one(&me, "koi");
        Self::count_burn("koi", 1, |b, n| b.koi += n);
        let n = Self::trophies_map().get(&me).unwrap_or(0) + 1;
        Self::trophies_map().insert(&me, &n);
        Self::bump_top(TROPHY_TOP_KEY, &me, n);
        n
    }

    /// Release a koi back into a zone: it restocks the zone by 20 fish, which
    /// helps every angler there and the zone's harbor master.
    pub fn release_koi(&mut self, zone_id: String) -> u64 {
        let me = env::predecessor_account_id();
        let mut z = self.load_zone(&zone_id);
        self.burn_one(&me, "koi");
        Self::count_burn("koi", 1, |b, n| b.koi += n);
        z.population = (z.population + KOI_RELEASE_RESTOCK).min(z.capacity);
        self.save_zone(&z);
        let n = Self::releases_map().get(&me).unwrap_or(0) + 1;
        Self::releases_map().insert(&me, &n);
        Self::bump_top(RELEASE_TOP_KEY, &me, n);
        z.population
    }

    pub fn trophies_of(&self, player: AccountId) -> u64 {
        Self::trophies_map().get(&player).unwrap_or(0)
    }
    pub fn releases_of(&self, player: AccountId) -> u64 {
        Self::releases_map().get(&player).unwrap_or(0)
    }
    pub fn license_discount_bps(&self, player: AccountId) -> u128 {
        self.trophy_discount_bps(&player)
    }
    /// Top trophy hunters and top conservationists.
    pub fn leaderboards(&self) -> (Vec<(AccountId, u64)>, Vec<(AccountId, u64)>) {
        (Self::read_top(TROPHY_TOP_KEY), Self::read_top(RELEASE_TOP_KEY))
    }

    // ------------------------------------------------------------ seasons

    pub fn current_season(&self) -> SeasonView {
        let week = env::block_timestamp() / WEEK_NS;
        let id = (week % SEASONS.len() as u64) as u8;
        SeasonView { week, id, name: SEASONS[id as usize].to_string(), ends_ns: (week + 1) * WEEK_NS }
    }

    // -------------------------------------------------------------- docks

    fn docks_map() -> LookupMap<String, (u64, u64)> { LookupMap::new(StorageKey::Docks) }

    fn burn_n(&mut self, player: &AccountId, item: &str, n: u64, msg: &str) {
        let hk = (player.clone(), item.to_string());
        let held = self.player_holdings.get(&hk).unwrap_or(0);
        if held < n {
            env::panic_str(msg);
        }
        self.player_holdings.insert(&hk, &(held - n));
    }

    /// A harbor master burns 20 snapper to build a dock: the zone holds 10%
    /// more fish (of its original capacity), up to 10 docks.
    pub fn build_dock(&mut self, zone_id: String) -> u64 {
        let me = env::predecessor_account_id();
        let mut z = self.load_zone(&zone_id);
        require!(z.steward.as_ref() == Some(&me), "only the zone's harbor master builds docks");
        let mut docks = Self::docks_map();
        let (base, n) = docks.get(&zone_id).unwrap_or((z.capacity, 0));
        require!(n < MAX_DOCKS, "this zone has all the docks it can hold");
        self.burn_n(&me, "snapper", DOCK_SNAPPER, "a dock takes 20 snapper");
        Self::count_burn("snapper", DOCK_SNAPPER, |b, n| b.docks += n);
        let add = (base as u128 * DOCK_CAPACITY_BPS / BPS) as u64;
        z.capacity += add.max(1);
        self.save_zone(&z);
        docks.insert(&zone_id, &(base, n + 1));
        z.capacity
    }

    /// (original capacity, docks built) for a zone.
    pub fn docks_of(&self, zone_id: String) -> (u64, u64) {
        Self::docks_map().get(&zone_id).unwrap_or_else(|| {
            let cap = Self::zones_map().get(&zone_id).map(|z| z.capacity).unwrap_or(0);
            (cap, 0)
        })
    }

    // -------------------------------------------------------------- orders

    fn orders_map() -> LookupMap<String, Order> { LookupMap::new(StorageKey::Orders) }

    fn order_key(npc_id: &str, item_id: &str) -> String {
        format!("{}:{}", npc_id, item_id)
    }

    /// Return an order's remaining escrow to its NPC and remove it.
    fn close_order_key(&mut self, key: &str) {
        let mut om = Self::orders_map();
        if let Some(o) = om.get(&key.to_string()) {
            if let Some(mut npc) = self.npcs.get(&o.npc_id) {
                npc.treasury += o.escrow;
                self.npcs.insert(&o.npc_id, &npc);
            }
            om.remove(&key.to_string());
        }
    }

    /// Orders were once one per NPC, keyed by the NPC id alone. Close any
    /// such order, returning its escrow. Owner-only, run once after upgrade.
    pub fn close_legacy_orders(&mut self) -> u32 {
        self.require_owner();
        let mut n = 0;
        for id in self.npcs.keys().collect::<Vec<_>>() {
            if Self::orders_map().get(&id).is_some() {
                self.close_order_key(&id);
                n += 1;
            }
        }
        n
    }

    /// An NPC posts an order for one fish: it locks `units * price` from its
    /// treasury in escrow and pays it out as players fill it. The price must
    /// be at least fair (an order is a premium) and inside the overpay band.
    /// An NPC may hold a few orders, one per fish; posting again for the same
    /// fish replaces that order.
    pub fn npc_post_order(&mut self, npc_id: String, item_id: String, units: u64, price: U128) {
        self.require_registered_npc_caller(&npc_id);
        require!(units >= 1 && units <= MAX_ORDER_SIZE, "order size out of range");
        require!(self.items.get(&item_id).is_some(), "unknown item");
        let fair = self.fair_price_of(&item_id);
        let ceiling = fair.saturating_mul(BPS + MAX_OVERPAY_BPS) / BPS;
        require!(price.0 >= fair && price.0 <= ceiling, "order price must sit between fair and +20%");
        let key = Self::order_key(&npc_id, &item_id);
        self.close_order_key(&key);
        let open = self.orders().iter().filter(|o| o.npc_id == npc_id).count();
        require!(open < MAX_ORDERS_PER_NPC, "this npc has too many open orders");
        let mut npc = self.npcs.get(&npc_id).unwrap();
        let cost = price.0 * units as u128 * ONE_NEAR / PRICE_SCALE;
        let spendable = npc.treasury.saturating_mul(BPS.saturating_sub(npc.reserve_bps)) / BPS;
        require!(cost <= spendable, "npc cannot fund this order");
        npc.treasury -= cost;
        self.npcs.insert(&npc_id, &npc);
        Self::orders_map().insert(&key, &Order {
            npc_id: npc_id.clone(),
            item_id,
            units_left: units,
            price: price.0,
            week: env::block_timestamp() / WEEK_NS,
            escrow: cost,
        });
    }

    /// Fill part of an NPC's order with fish you hold. You are paid from the
    /// order's escrow; the fish join the NPC's inventory at the order price.
    pub fn fill_order(&mut self, npc_id: String, item_id: String, units: u64) -> Promise {
        let key = Self::order_key(&npc_id, &item_id);
        let mut om = Self::orders_map();
        let mut o = om.get(&key).unwrap_or_else(|| env::panic_str("this npc has no open order for that fish"));
        require!(o.week == env::block_timestamp() / WEEK_NS, "this order has expired");
        require!(units >= 1 && units <= o.units_left, "more units than the order needs");
        let me = env::predecessor_account_id();
        self.burn_n(&me, &o.item_id, units, "you do not hold enough of that fish");
        let pay = o.price * units as u128 * ONE_NEAR / PRICE_SCALE;
        o.units_left -= units;
        o.escrow -= pay.min(o.escrow);

        let mut npc = self.npcs.get(&npc_id).unwrap();
        npc.add_units(&o.item_id, units, o.price);
        npc.trades += 1;
        self.npcs.insert(&npc_id, &npc);

        let mut item = self.items.get(&o.item_id).unwrap();
        self.roll_window(&mut item);
        item.npc_buy_volume += units;
        self.items.insert(&o.item_id, &item);
        self.record_trade(TradeRecord {
            kind: "order_fill".to_string(),
            npc_id: npc_id.clone(),
            counterparty: me.clone(),
            item_id: o.item_id.clone(),
            units,
            price: o.price,
            fair_price: self.fair_price_of(&o.item_id),
            at_ns: env::block_timestamp(),
        });

        om.insert(&key, &o);
        if o.units_left == 0 {
            // Rounding dust goes back to the NPC.
            self.close_order_key(&key);
        }
        Promise::new(me).transfer(NearToken::from_yoctonear(pay))
    }

    /// Anyone may expire last week's order, returning its escrow to the NPC.
    pub fn expire_order(&mut self, npc_id: String, item_id: String) {
        let key = Self::order_key(&npc_id, &item_id);
        let o = Self::orders_map().get(&key).unwrap_or_else(|| env::panic_str("no order"));
        require!(o.week < env::block_timestamp() / WEEK_NS, "this order is still open");
        self.close_order_key(&key);
    }

    /// Every open order: one per (NPC, fish), plus any legacy order.
    pub fn orders(&self) -> Vec<Order> {
        let om = Self::orders_map();
        let items: Vec<String> = self.items.keys().collect();
        let mut out = Vec::new();
        for npc in self.npcs.keys() {
            if let Some(o) = om.get(&npc) {
                out.push(o);
            }
            for it in items.iter() {
                if let Some(o) = om.get(&Self::order_key(&npc, it)) {
                    out.push(o);
                }
            }
        }
        out
    }

    // ------------------------------------------------------------- fishdex

    fn dex_map() -> LookupMap<AccountId, u8> { LookupMap::new(StorageKey::Fishdex) }

    fn mark_fishdex(&mut self, player: &AccountId, item: &str) {
        if let Some(bit) = FISHDEX_SPECIES.iter().position(|s| *s == item) {
            let mut m = Self::dex_map();
            let before = m.get(player).unwrap_or(0);
            let after = before | (1u8 << bit);
            if after != before {
                m.insert(player, &after);
                if after == (1u8 << FISHDEX_SPECIES.len()) - 1 {
                    env::log_str(&format!("FISHDEX COMPLETE: {} has landed every species", player));
                }
            }
        }
    }

    fn fishdex_complete(&self, player: &AccountId) -> bool {
        Self::dex_map().get(player).unwrap_or(0) == (1u8 << FISHDEX_SPECIES.len()) - 1
    }

    pub fn fishdex(&self, player: AccountId) -> FishdexView {
        let mask = Self::dex_map().get(&player).unwrap_or(0);
        FishdexView {
            caught: FISHDEX_SPECIES
                .iter()
                .enumerate()
                .filter(|(i, _)| mask & (1u8 << i) != 0)
                .map(|(_, s)| s.to_string())
                .collect(),
            complete: mask == (1u8 << FISHDEX_SPECIES.len()) - 1,
        }
    }

    // ------------------------------------------------------ batched views

    pub fn world_state(&self, trades: Option<u32>) -> WorldState {
        let week = self.current_week();
        let zones = self.all_zones();
        let docks = zones.iter().map(|v| (v.zone.id.clone(), self.docks_of(v.zone.id.clone()).1)).collect();
        WorldState {
            items: self.market_snapshot(),
            npcs: self.all_npcs(),
            zones,
            crews: Self::zone_ids().into_iter().map(|z| (z.clone(), self.crew_of(z))).collect(),
            docks,
            orders: self.orders(),
            listings: self.open_listings(),
            trades: self.recent_trades(trades.unwrap_or(30)),
            season: self.current_season(),
            tournament: self.tournament(week),
            last_tournament: self.tournament(week.saturating_sub(1)),
            records: self.records(),
            leaderboards: self.leaderboards(),
            vault: U128(self.vault_balance),
            solvency: self.solvency(),
            notes: self.npc_notes(),
            supply: self.supply(),
        }
    }

    pub fn player_state(&self, player: AccountId) -> PlayerState {
        let items: Vec<String> = self.items.keys().collect();
        PlayerState {
            holdings: items.iter().map(|i| (i.clone(), self.holdings(player.clone(), i.clone()))).collect(),
            bests: items.iter().map(|i| (i.clone(), self.personal_best(player.clone(), i.clone()))).collect(),
            rod: self.rod_of(player.clone()),
            rods: self.rods_of(player.clone()),
            rod_status: self.rod_status(player.clone()),
            catches_left: self.catches_left_today(player.clone()),
            trophies: self.trophies_of(player.clone()),
            releases: self.releases_of(player.clone()),
            discount_bps: self.trophy_discount_bps(&player),
            entered_this_week: self.is_entered(player.clone(), self.current_week()),
            fishdex: self.fishdex(player),
        }
    }

    // -------------------------------------------------- weekly tournament

    pub fn current_week(&self) -> u64 {
        env::block_timestamp() / WEEK_NS
    }

    /// Enter this week's tournament. From now until the week ends, your
    /// heaviest fish in each zone competes for that zone's share of the pot.
    #[payable]
    pub fn enter_tournament(&mut self) {
        let me = env::predecessor_account_id();
        let week = self.current_week();
        let mut ent = Self::entrants_map();
        require!(ent.get(&(week, me.clone())).is_none(), "you are already entered this week");
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= TOURNAMENT_TICKET, "attach the 0.1 NEAR ticket");
        ent.insert(&(week, me.clone()), &true);
        let (pot, n) = Self::pot_map().get(&week).unwrap_or((0, 0));
        Self::pot_map().insert(&week, &(pot + TOURNAMENT_TICKET, n + 1));
        Self::write_u128(TOURNEY_HELD_KEY, Self::read_u128(TOURNEY_HELD_KEY) + TOURNAMENT_TICKET);
        if attached > TOURNAMENT_TICKET {
            let _ = Promise::new(me).transfer(NearToken::from_yoctonear(attached - TOURNAMENT_TICKET));
        }
    }

    pub fn is_entered(&self, player: AccountId, week: u64) -> bool {
        Self::entrants_map().get(&(week, player)).is_some()
    }

    pub fn tournament(&self, week: u64) -> TournamentView {
        let (pot, entrants) = Self::pot_map().get(&week).unwrap_or((0, 0));
        let lm = Self::leader_map();
        let leaders = Self::zone_ids()
            .into_iter()
            .filter_map(|z| lm.get(&(week, z.clone())).map(|(w, a, i)| (z, w, a, i)))
            .collect();
        TournamentView {
            week,
            ends_ns: (week + 1) * WEEK_NS,
            pot: U128(pot),
            entrants,
            settled: Self::settled_map().get(&week).is_some(),
            leaders,
        }
    }

    /// Pay out a finished week. Anyone may call it. 5% goes to the vault; the
    /// rest is split evenly between the zone winners. A week with no winner
    /// rolls its pot into the current week.
    pub fn settle_tournament(&mut self, week: u64) {
        let now_week = self.current_week();
        require!(week < now_week, "this week is still running");
        require!(Self::settled_map().get(&week).is_none(), "already settled");
        Self::settled_map().insert(&week, &true);
        let (pot, _) = Self::pot_map().get(&week).unwrap_or((0, 0));
        if pot == 0 {
            return;
        }
        let t = self.tournament(week);
        let house = pot * TOURNAMENT_HOUSE_BPS / BPS;
        let prize = pot - house;
        let held = Self::read_u128(TOURNEY_HELD_KEY);
        if t.leaders.is_empty() {
            // Nobody landed a fish: the whole pot carries over.
            let (cur, n) = Self::pot_map().get(&now_week).unwrap_or((0, 0));
            Self::pot_map().insert(&now_week, &(cur + pot, n));
            return;
        }
        let share = prize / t.leaders.len() as u128;
        let dust = prize - share * t.leaders.len() as u128;
        self.vault_balance += house + dust;
        Self::write_u128(TOURNEY_HELD_KEY, held.saturating_sub(pot));
        for (zone, w, who, item) in t.leaders {
            env::log_str(&format!("TOURNAMENT week {}: {} wins {} with a {}g {}", week, who, zone, w, item));
            let _ = Promise::new(who).transfer(NearToken::from_yoctonear(share));
        }
    }

    // ---------------------------------------------------------------- crew

    fn crew_map() -> LookupMap<String, Vec<(AccountId, u128)>> { LookupMap::new(StorageKey::Crew) }

    fn crew_total(zone_id: &str) -> u128 {
        Self::crew_map().get(&zone_id.to_string()).unwrap_or_default().iter().map(|(_, a)| a).sum()
    }

    /// Pay out a zone's earnings pro rata to the harbor master's own stake
    /// and each crew member's stake. With `refund_stakes`, every stake comes
    /// back too and the crew disbands (the harbor master is leaving).
    fn pay_out(&mut self, z: &mut Zone, refund_stakes: bool) {
        let crew = Self::crew_map().get(&z.id).unwrap_or_default();
        // Weights in milliNEAR: earned (yocto) * stake (yocto) would overflow
        // u128, while earned * stake-in-milliNEAR stays far inside it.
        const MILLI: u128 = ONE_NEAR / 1_000;
        let total: u128 = (z.steward_stake + crew.iter().map(|(_, a)| a).sum::<u128>()) / MILLI;
        let earned = z.steward_earned;
        let mut paid = 0u128;
        for (who, amount) in crew.iter() {
            let share = if total == 0 { 0 } else { earned * (amount / MILLI) / total };
            paid += share;
            let out = share + if refund_stakes { *amount } else { 0 };
            if out > 0 {
                let _ = Promise::new(who.clone()).transfer(NearToken::from_yoctonear(out));
            }
        }
        // The harbor master takes the rest, including rounding dust.
        let mine = earned - paid + if refund_stakes { z.steward_stake } else { 0 };
        if let Some(st) = z.steward.clone() {
            if mine > 0 {
                let _ = Promise::new(st).transfer(NearToken::from_yoctonear(mine));
            }
        }
        z.steward_earned = 0;
        if refund_stakes {
            Self::crew_map().remove(&z.id);
        }
    }

    /// Back the current harbor master with NEAR. Your stake makes the zone
    /// harder to take and earns its pro-rata share of the zone's earnings.
    /// It comes back in full when the harbor master resigns or is outbid.
    #[payable]
    pub fn back_steward(&mut self, zone_id: String) {
        let z = self.load_zone(&zone_id);
        let me = env::predecessor_account_id();
        require!(z.steward.is_some(), "this zone has no harbor master to back");
        require!(z.steward.as_ref() != Some(&me), "you are the harbor master");
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount >= MIN_CREW_STAKE, "back with at least 0.1 NEAR");
        let mut crew = Self::crew_map().get(&zone_id).unwrap_or_default();
        match crew.iter_mut().find(|(a, _)| a == &me) {
            Some(entry) => entry.1 += amount,
            None => {
                require!(crew.len() < MAX_CREW, "this crew is full");
                crew.push((me, amount));
            }
        }
        Self::crew_map().insert(&zone_id, &crew);
    }

    /// A zone's crew: (member, stake).
    pub fn crew_of(&self, zone_id: String) -> Vec<(AccountId, U128)> {
        Self::crew_map().get(&zone_id).unwrap_or_default().into_iter().map(|(a, s)| (a, U128(s))).collect()
    }

    /// Stake to become a zone's steward. A vacant zone needs the minimum
    /// stake; an occupied one needs 20% more than the harbor master's stake
    /// plus their crew's. Everyone displaced is refunded in full, with their
    /// share of unclaimed earnings.
    #[payable]
    pub fn become_steward(&mut self, zone_id: String) {
        let mut z = self.load_zone(&zone_id);
        let stake = env::attached_deposit().as_yoctonear();
        let me = env::predecessor_account_id();
        require!(z.steward.as_ref() != Some(&me), "you already steward this zone");
        let defended = z.steward_stake + Self::crew_total(&zone_id);
        let needed = if z.steward.is_some() {
            (defended * STEWARD_OUTBID_BPS / BPS).max(STEWARD_MIN_STAKE)
        } else {
            STEWARD_MIN_STAKE
        };
        require!(stake >= needed, "stake too small to take this zone");
        if z.steward.is_some() {
            self.pay_out(&mut z, true);
        }
        z.steward = Some(me);
        z.steward_stake = stake;
        z.steward_earned = 0;
        z.steward_since_ns = env::block_timestamp();
        z.fee_bps = BPS;
        z.closed = false;
        self.save_zone(&z);
    }

    /// The steward sets the zone's fee multiplier (0.5x..2x) and may close it
    /// to let the population recover.
    pub fn set_zone_policy(&mut self, zone_id: String, fee_bps: U128, closed: bool) {
        let mut z = self.load_zone(&zone_id);
        require!(z.steward.as_ref() == Some(&env::predecessor_account_id()), "only the steward sets policy");
        require!(fee_bps.0 >= 5_000 && fee_bps.0 <= 20_000, "fee multiplier must be 0.5x to 2x");
        z.fee_bps = fee_bps.0;
        z.closed = closed;
        self.save_zone(&z);
    }

    /// The harbor master pays out the zone's earnings to itself and its crew,
    /// pro rata by stake.
    pub fn claim_steward_earnings(&mut self, zone_id: String) {
        let mut z = self.load_zone(&zone_id);
        require!(z.steward.as_ref() == Some(&env::predecessor_account_id()), "only the steward");
        require!(z.steward_earned > 0, "nothing earned yet");
        self.pay_out(&mut z, false);
        self.save_zone(&z);
    }

    /// Step down after the lock period. Stake, crew stakes and every share of
    /// unclaimed earnings go back to their owners.
    pub fn resign_steward(&mut self, zone_id: String) {
        let mut z = self.load_zone(&zone_id);
        let me = env::predecessor_account_id();
        require!(z.steward.as_ref() == Some(&me), "only the steward");
        require!(
            env::block_timestamp() >= z.steward_since_ns + STEWARD_LOCK_SECONDS * 1_000_000_000,
            "stewardship is locked for 24 hours"
        );
        self.pay_out(&mut z, true);
        z.steward = None;
        z.steward_stake = 0;
        z.fee_bps = BPS;
        z.closed = false;
        self.save_zone(&z);
    }

    fn daily_cap(&self, player: &AccountId) -> u64 {
        MAX_CATCHES_PER_DAY + if self.fishdex_complete(player) { FISHDEX_BONUS } else { 0 }
    }

    fn count_daily_catch(&mut self, player: &AccountId, units: u64) {
        let day = env::block_timestamp() / 86_400_000_000_000;
        let (d, n) = self.daily_catch.get(player).unwrap_or((day, 0));
        let n = if d == day { n } else { 0 };
        require!(n + units <= self.daily_cap(player), "daily catch limit reached, the sea needs rest");
        self.daily_catch.insert(player, &(day, n + units));
    }

    /// Fish a player may still claim today.
    pub fn catches_left_today(&self, player: AccountId) -> u64 {
        let day = env::block_timestamp() / 86_400_000_000_000;
        let cap = self.daily_cap(&player);
        match self.daily_catch.get(&player) {
            Some((d, n)) if d == day => cap.saturating_sub(n),
            _ => cap,
        }
    }

    fn rod_set_map() -> LookupMap<AccountId, u8> { LookupMap::new(StorageKey::RodSet) }

    /// Bitmask of rods a player owns, including rods bought before rods
    /// became a set (the old tier maps onto carbon or master).
    fn rod_bits(&self, player: &AccountId) -> u8 {
        let mut bits = Self::rod_set_map().get(player).unwrap_or(0);
        match self.rods.get(player).unwrap_or(ROD_WOODEN) {
            ROD_CARBON => bits |= 1 << 1,
            ROD_MASTER => bits |= (1 << 1) | (1 << 3),
            _ => {}
        }
        bits
    }

    /// Get a rod: pay its NEAR price (to the vault), or craft it by burning
    /// the fish in its recipe. A new rod starts at full durability.
    #[payable]
    pub fn acquire_rod(&mut self, rod_id: String, craft: bool) {
        let spec = RODS.iter().find(|r| r.id == rod_id).unwrap_or_else(|| env::panic_str("unknown rod"));
        let me = env::predecessor_account_id();
        let bits = self.rod_bits(&me);
        require!(bits & (1 << spec.bit) == 0, "you already own this rod");
        let attached = env::attached_deposit().as_yoctonear();
        if craft {
            require!(!spec.recipe.is_empty(), "this rod cannot be crafted, only bought");
            if spec.id == "legendary" {
                require!(self.trophies_of(me.clone()) >= LEGENDARY_MIN_TROPHIES, "the Legendary Rod needs a mounted koi trophy");
                require!(
                    self.personal_best(me.clone(), "tuna".into()) >= LEGENDARY_MIN_TUNA_G,
                    "the Legendary Rod needs a personal-best tuna of 30 kg or more"
                );
            }
            for (item, n) in spec.recipe.iter() {
                self.burn_n(&me, item, *n, "you do not have the fish this rod is crafted from");
                Self::count_burn(item, *n, |b, n| b.rods += n);
            }
            if attached > 0 {
                let _ = Promise::new(me.clone()).transfer(NearToken::from_yoctonear(attached));
            }
        } else {
            require!(spec.price > 0, "this rod can only be crafted");
            require!(attached >= spec.price, "attach the rod price");
            self.vault_balance += spec.price;
            if attached > spec.price {
                let _ = Promise::new(me.clone()).transfer(NearToken::from_yoctonear(attached - spec.price));
            }
        }
        Self::rod_set_map().insert(&me, &(bits | (1 << spec.bit)));
        Self::rod_wear_map().remove(&Self::wear_key(&me, spec.id));
    }

    fn rod_wear_map() -> LookupMap<String, u32> { LookupMap::new(StorageKey::RodWear) }
    fn wear_key(player: &AccountId, rod: &str) -> String { format!("{}:{}", player, rod) }

    /// Repair a rod to full durability: pay its repair price in NEAR (15% to
    /// this week's tournament pot, the rest to the vault), or burn fish.
    #[payable]
    pub fn repair_rod(&mut self, rod_id: String, with_fish: bool) {
        let spec = RODS.iter().find(|r| r.id == rod_id).unwrap_or_else(|| env::panic_str("unknown rod"));
        let me = env::predecessor_account_id();
        require!(self.rod_bits(&me) & (1 << spec.bit) != 0, "you do not own this rod");
        let wk = Self::wear_key(&me, spec.id);
        require!(Self::rod_wear_map().get(&wk).unwrap_or(0) > 0, "this rod is already in perfect shape");
        let attached = env::attached_deposit().as_yoctonear();
        if with_fish {
            for (item, n) in spec.repair_recipe.iter() {
                self.burn_n(&me, item, *n, "you do not have the fish to repair this rod");
                Self::count_burn(item, *n, |b, n| b.rods += n);
            }
            if attached > 0 {
                let _ = Promise::new(me.clone()).transfer(NearToken::from_yoctonear(attached));
            }
        } else {
            require!(attached >= spec.repair, "attach the repair price");
            let to_pot = spec.repair * REPAIR_POT_BPS / BPS;
            let week = self.current_week();
            let (pot, n) = Self::pot_map().get(&week).unwrap_or((0, 0));
            Self::pot_map().insert(&week, &(pot + to_pot, n));
            Self::write_u128(TOURNEY_HELD_KEY, Self::read_u128(TOURNEY_HELD_KEY) + to_pot);
            self.vault_balance += spec.repair - to_pot;
            if attached > spec.repair {
                let _ = Promise::new(me.clone()).transfer(NearToken::from_yoctonear(attached - spec.repair));
            }
        }
        Self::rod_wear_map().remove(&wk);
    }

    /// Every rod a player owns with the durability it has left.
    pub fn rod_status(&self, player: AccountId) -> Vec<RodStatus> {
        let bits = self.rod_bits(&player);
        let wm = Self::rod_wear_map();
        RODS.iter()
            .filter(|r| bits & (1 << r.bit) != 0)
            .map(|r| {
                let worn = wm.get(&Self::wear_key(&player, r.id)).unwrap_or(0);
                RodStatus { id: r.id.to_string(), left: r.durability.saturating_sub(worn), durability: r.durability }
            })
            .collect()
    }

    /// Move whatever the vault holds above `VAULT_CEILING` into this week's
    /// tournament pot. Anyone may call it: the vault keeps its reserve, and
    /// the surplus goes back to the players who fish best. Returns the amount.
    pub fn sweep_vault_surplus(&mut self) -> U128 {
        let surplus = self.vault_balance.saturating_sub(VAULT_CEILING);
        if surplus == 0 {
            return U128(0);
        }
        self.vault_balance -= surplus;
        let week = self.current_week();
        let (pot, n) = Self::pot_map().get(&week).unwrap_or((0, 0));
        Self::pot_map().insert(&week, &(pot + surplus, n));
        Self::write_u128(TOURNEY_HELD_KEY, Self::read_u128(TOURNEY_HELD_KEY) + surplus);
        env::log_str(&format!("sweep_vault_surplus: {} yocto to week {}", surplus, week));
        U128(surplus)
    }

    fn notes_map() -> LookupMap<String, NpcNote> { LookupMap::new(StorageKey::NpcNotes) }

    /// Publish a market note from an NPC's own account. `source` says what
    /// wrote it ("near-ai" or "rules"), so players can tell.
    pub fn npc_post_note(&mut self, npc_id: String, text: String, source: String) {
        self.require_registered_npc_caller(&npc_id);
        let text = text.trim().to_string();
        require!(!text.is_empty(), "empty note");
        require!(text.chars().count() <= MAX_NOTE_CHARS, "note too long");
        require!(source == "near-ai" || source == "rules", "unknown note source");
        Self::notes_map().insert(&npc_id, &NpcNote { npc_id: npc_id.clone(), text, source, at_ns: env::block_timestamp() });
    }

    /// The latest note from each NPC.
    pub fn npc_notes(&self) -> Vec<NpcNote> {
        let m = Self::notes_map();
        self.npcs.keys().filter_map(|id| m.get(&id)).collect()
    }

    fn burned_map() -> LookupMap<String, Burned> { LookupMap::new(StorageKey::Burned) }

    fn count_burn(item: &str, n: u64, f: impl Fn(&mut Burned, u64)) {
        let mut m = Self::burned_map();
        let mut b = m.get(&item.to_string()).unwrap_or_default();
        f(&mut b, n);
        m.insert(&item.to_string(), &b);
    }

    /// Fish of this kind in circulation: caught, minus everything burned.
    fn circulating(&self, item: &str) -> u64 {
        let minted = self.items.get(&item.to_string()).map(|i| i.total_minted).unwrap_or(0);
        let b = Self::burned_map().get(&item.to_string()).unwrap_or_default();
        let bait = Self::bait_burned_map().get(&item.to_string()).unwrap_or(0);
        minted.saturating_sub(bait + b.rods + b.vault + b.docks + b.koi)
    }

    /// How fast a zone regrows right now, in bps of its normal rate: full
    /// while its staple fish is at or below target, slower above it.
    pub fn regen_factor_bps(&self, zone_id: String) -> U128 {
        U128(self.regen_factor(&zone_id))
    }

    fn regen_factor(&self, zone_id: &str) -> u128 {
        match SUPPLY_TARGETS.iter().find(|(z, _, _)| *z == zone_id) {
            Some((_, fish, target)) => {
                let c = self.circulating(fish);
                if c <= *target {
                    BPS
                } else {
                    (*target as u128 * BPS / c as u128).max(MIN_REGEN_BPS)
                }
            }
            None => BPS,
        }
    }

    /// The supply ledger for every fish.
    pub fn supply(&self) -> Vec<SupplyView> {
        self.items
            .keys()
            .map(|id| {
                let t = SUPPLY_TARGETS.iter().find(|(_, f, _)| *f == id);
                SupplyView {
                    minted: self.items.get(&id).map(|i| i.total_minted).unwrap_or(0),
                    burned_bait: Self::bait_burned_map().get(&id).unwrap_or(0),
                    burned: Self::burned_map().get(&id).unwrap_or_default(),
                    circulating: self.circulating(&id),
                    target: t.map(|(_, _, n)| *n),
                    zone: t.map(|(z, _, _)| z.to_string()),
                    regen_bps: t.map(|(z, _, _)| U128(self.regen_factor(z))),
                    item_id: id,
                }
            })
            .collect()
    }

    /// Buy fish another player listed. The price is the seller's ask, paid
    /// straight to the seller; `max_price` protects the buyer if the listing
    /// changed. Listings live 30 minutes, like for NPCs.
    #[payable]
    pub fn buy_listing(&mut self, listing_index: u64, units: u64, max_price: U128) {
        let buyer = env::predecessor_account_id();
        let mut listing = self.listings.get(listing_index).unwrap_or_else(|| env::panic_str("no such listing"));
        require!(listing.active, "listing closed");
        require!(units >= 1 && units <= listing.units, "not that many units listed");
        require!(listing.seller != buyer, "you cannot buy your own listing");
        require!(
            env::block_timestamp().saturating_sub(listing.created_ns) < LISTING_TTL_SECONDS * 1_000_000_000,
            "listing has expired"
        );
        require!(listing.ask_price <= max_price.0, "the listing costs more than your max price");
        let cost = listing.ask_price * units as u128 * ONE_NEAR / PRICE_SCALE;
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "attach the price of the units");

        listing.units -= units;
        if listing.units == 0 {
            listing.active = false;
        }
        self.listings.replace(listing_index, &listing);

        let mut item = self.items.get(&listing.item_id).unwrap();
        self.roll_window(&mut item);
        item.listed_supply = item.listed_supply.saturating_sub(units);
        item.player_buy_volume += units;
        self.items.insert(&listing.item_id, &item);

        let hk = (buyer.clone(), listing.item_id.clone());
        let held = self.player_holdings.get(&hk).unwrap_or(0);
        self.player_holdings.insert(&hk, &(held + units));

        self.record_trade(TradeRecord {
            kind: "p2p".to_string(),
            npc_id: listing.seller.to_string(),
            counterparty: buyer.clone(),
            item_id: listing.item_id.clone(),
            units,
            price: listing.ask_price,
            fair_price: self.fair_price_of(&listing.item_id),
            at_ns: env::block_timestamp(),
        });
        if attached > cost {
            let _ = Promise::new(buyer).transfer(NearToken::from_yoctonear(attached - cost));
        }
        let _ = Promise::new(listing.seller).transfer(NearToken::from_yoctonear(cost));
    }

    /// What the vault pays right now, in basis points of fair price.
    pub fn vault_bid_bps(&self) -> u128 {
        VAULT_PRICE_BPS * self.vault_balance.min(VAULT_TARGET) / VAULT_TARGET
    }

    /// Set a zone's base license fee. Owner-only.
    pub fn set_zone_fee(&mut self, zone_id: String, base_fee: U128) {
        self.require_owner();
        let mut z = Self::zones_map().get(&zone_id).unwrap_or_else(|| env::panic_str("unknown zone"));
        z.base_fee = base_fee.0;
        self.save_zone(&z);
    }

    /// The rods a player owns, by id. Every player needs at least one to fish.
    pub fn rods_of(&self, player: AccountId) -> Vec<String> {
        let bits = self.rod_bits(&player);
        RODS.iter().filter(|r| bits & (1 << r.bit) != 0).map(|r| r.id.to_string()).collect()
    }

    /// The best rod tier a player owns (0 wooden, 1, 2).
    pub fn rod_of(&self, player: AccountId) -> u8 {
        let bits = self.rod_bits(&player);
        RODS.iter().filter(|r| bits & (1 << r.bit) != 0).map(|r| r.tier).max().unwrap_or(ROD_WOODEN)
    }

    /// Top up an NPC's treasury. Anyone may fund an NPC — a richer NPC
    /// trades more, which is what keeps the market liquid.
    #[payable]
    pub fn fund_npc(&mut self, npc_id: String) {
        let mut npc = self
            .npcs
            .get(&npc_id)
            .unwrap_or_else(|| env::panic_str("unknown npc"));
        npc.treasury += env::attached_deposit().as_yoctonear();
        self.npcs.insert(&npc_id, &npc);
    }

    /// Set the game server's public key. Owner-only: this key vouches for
    /// every catch, so whoever controls it can mint units.
    pub fn set_game_signer(&mut self, public_key: String) {
        self.require_owner();
        // Reject a malformed key here rather than at the first catch, where
        // the failure would look like a client bug.
        public_key
            .parse::<PublicKey>()
            .unwrap_or_else(|_| env::panic_str("malformed public key"));
        self.game_signer_public_key = public_key;
    }

    /// Units of an item a player holds.
    pub fn holdings(&self, player: AccountId, item_id: String) -> u64 {
        self.player_holdings
            .get(&(player, item_id))
            .unwrap_or(0)
    }

    /// A player lists units for sale. The units are notionally escrowed by
    /// the listing; the contract tracks them so supply and scarcity react.
    pub fn list(&mut self, item_id: String, units: u64, ask_price: U128) {
        require!(units >= MIN_ORDER_UNITS, "order too small");
        require!(units <= MAX_ORDER_UNITS, "order too large");

        // The seller must actually hold the units. Without this check any
        // caller could list unlimited supply and crash the price, which is
        // the whole market-manipulation surface.
        let player = env::predecessor_account_id();
        let held = self.holdings(player.clone(), item_id.clone());
        require!(held >= units, "you do not hold that many units");
        let mut item = self
            .items
            .get(&item_id)
            .unwrap_or_else(|| env::panic_str("unknown item"));

        let seller = env::predecessor_account_id();
        let open = self
            .listings
            .iter()
            .filter(|l| l.active && l.seller == seller)
            .count() as u64;
        require!(
            open < MAX_LISTINGS_PER_SELLER as u64,
            "too many open listings"
        );

        item.listed_supply += units;
        // Snapshot the fair price *including* this listing's own supply
        // contribution, so the band check is against a price the seller
        // could actually have transacted at.
        let npc_stock = self.npc_inventory_of(item_id.clone());
        let fair = item.fair_price(npc_stock);
        self.items.insert(&item_id, &item);

        // Move the units out of the player's holdings and into the listing.
        let key = (player.clone(), item_id.clone());
        self.player_holdings.insert(&key, &(held - units));

        self.listings.push(&Listing {
            seller,
            item_id,
            units,
            ask_price: ask_price.0,
            fair_at_list: fair,
            created_ns: env::block_timestamp(),
            active: true,
        });
    }

    /// List units at the current fair price.
    ///
    /// Convenience for players and for the demo harness: the ask is set to
    /// whatever the pricing engine says right now, which is always inside
    /// the overpay band by construction. The band check still applies to
    ///  with an explicit price.
    /// Sell straight to the market vault at the current fair price.
    ///
    /// This is the "sell all" button: the player gets NEAR immediately
    /// instead of waiting for an NPC to take the listing. The vault is funded
    /// by NPC treasuries and player buys, so it is real money, not a number
    /// the contract made up.
    ///
    /// A listing that has to wait for a buyer is a different product — that
    /// is what `list` is for.
    #[payable]
    pub fn sell_to_market(&mut self, item_id: String, units: u64) {
        require!(units >= MIN_ORDER_UNITS, "order too small");
        require!(units <= MAX_ORDER_UNITS, "order too large");

        let player = env::predecessor_account_id();
        let held = self.holdings(player.clone(), item_id.clone());
        require!(held >= units, "you do not hold that many units");

        let mut item = self
            .items
            .get(&item_id)
            .unwrap_or_else(|| env::panic_str("unknown item"));
        self.roll_window(&mut item);

        // Price the sale *after* its own supply impact, so dumping a big
        // haul pays less per fish than selling a few.
        item.vault_intake = item.vault_intake.saturating_add(units);
        let npc_stock = self.npc_inventory_of(item_id.clone());
        let fair = item.fair_price(npc_stock);
        let price = fair * self.vault_bid_bps() / BPS;
        require!(price > 0, "the vault is empty and is not buying");
        let cost = price * units as u128 * ONE_NEAR / PRICE_SCALE;

        // The vault pays from its own balance only. NPC treasuries and
        // investor principal are owed to someone else and are never touched.
        require!(
            cost <= self.vault_balance,
            "the market vault cannot cover this sale right now"
        );
        self.vault_balance -= cost;
        // The vault does not keep fish: what it buys leaves circulation.
        Self::count_burn(&item_id, units, |b, n| b.vault += n);

        let key = (player.clone(), item_id.clone());
        self.player_holdings.insert(&key, &(held - units));
        self.items.insert(&item_id, &item);

        self.record_trade(TradeRecord {
            kind: "player_sell".to_string(),
            npc_id: "market".to_string(),
            counterparty: player.clone(),
            item_id: item_id.clone(),
            units,
            price,
            fair_price: fair,
            at_ns: env::block_timestamp(),
        });

        let _ = Promise::new(player).transfer(NearToken::from_yoctonear(cost));
    }

    /// Fund the market vault. Anyone may top it up; the vault is what pays
    /// players who sell straight to the market, so it has to hold real NEAR.
    ///
    /// NPC treasuries feed it too — see `register_npc`, which transfers the
    /// treasury in — so the economy is self-sustaining rather than dependent
    /// on the owner.
    #[payable]
    pub fn fund_vault(&mut self, _amount: U128) {
        self.vault_balance += env::attached_deposit().as_yoctonear();
    }

    /// NEAR currently owned by the market vault.
    pub fn vault_balance(&self) -> U128 {
        U128(self.vault_balance)
    }

    /// Solvency check: everything the contract owes (NPC treasuries and the
    /// vault) plus its storage must be covered by what it actually holds.
    pub fn solvency(&self) -> Solvency {
        let treasuries: u128 = self.npcs.values().map(|n| n.treasury).sum();
        let stewards: u128 = Self::zone_ids()
            .into_iter()
            .filter_map(|id| Self::zones_map().get(&id))
            .map(|z| z.steward_stake + z.steward_earned + Self::crew_total(&z.id))
            .sum();
        let tourney = Self::read_u128(TOURNEY_HELD_KEY);
        let escrow: u128 = self.orders().iter().map(|o| o.escrow).sum();
        let liabilities = treasuries + self.vault_balance + stewards + tourney + escrow;
        let storage = self.storage_reserve();
        let balance = env::account_balance().as_yoctonear();
        Solvency {
            balance: U128(balance),
            liabilities: U128(liabilities),
            storage: U128(storage),
            npc_treasuries: U128(treasuries),
            vault: U128(self.vault_balance),
            stewards: U128(stewards),
            tournaments: U128(tourney),
            order_escrow: U128(escrow),
            solvent: balance >= liabilities + storage,
        }
    }

    /// NEAR the contract must keep locked for its own storage. Sales cannot
    /// spend below this or the contract becomes unusable.
    fn storage_reserve(&self) -> u128 {
        env::storage_usage() as u128 * 10_000_000_000_000_000_000
    }

    pub fn list_fair(&mut self, item_id: String, units: u64) {
        // The listing itself adds supply, which moves the price. Compute the
        // fair price *including* this listing's own supply contribution, so
        // the ask sits inside the overpay band by construction.
        //
        // The supply increment happens in `list`, which also does the
        // holdings check and deduction — doing it here as well would count
        // the same units twice.
        let key = item_id.clone();
        let mut item = self
            .items
            .get(&key)
            .unwrap_or_else(|| env::panic_str("unknown item"));
        // Roll the pricing window first, exactly as the view path does. Without
        // this the ask is computed from stale volumes and lands far outside
        // the band the buy path enforces — the listing is unsellable from the
        // moment it is created.
        self.roll_window(&mut item);
        self.items.insert(&key, &item);
        let npc_stock = self.npc_inventory_of(item_id.clone());
        // Price the ask *after* this listing's own supply lands, which is the
        // price the listing will actually be judged against.
        let fair = item.fair_price_with_supply(npc_stock, item.listed_supply.saturating_add(units));
        self.list(item_id, units, U128(fair));
    }

    /// A player cancels a listing and reclaims the units.
    pub fn cancel_listing(&mut self, index: u64) {
        let mut listing = self
            .listings
            .get(index)
            .unwrap_or_else(|| env::panic_str("no such listing"));
        require!(listing.active, "listing already closed");
        require!(
            listing.seller == env::predecessor_account_id(),
            "not your listing"
        );
        listing.active = false;
        self.listings.replace(index, &listing);

        let mut item = self.items.get(&listing.item_id).unwrap();
        item.listed_supply = item.listed_supply.saturating_sub(listing.units);
        self.items.insert(&listing.item_id, &item);

        // The units go back to the seller: cancelling is not burning.
        let key = (listing.seller.clone(), listing.item_id.clone());
        let held = self.player_holdings.get(&key).unwrap_or(0);
        self.player_holdings.insert(&key, &(held + listing.units));
    }

    /// Expire a listing that has sat past its TTL.
    ///
    /// Anyone may call this: an expired listing is dead supply that drags the
    /// price down while nobody may buy it, so clearing it is a service to the
    /// market, not a privileged action. The units return to the seller's
    /// holdings so nothing is lost.
    pub fn expire_listing(&mut self, index: u64) {
        let mut listing = self
            .listings
            .get(index)
            .unwrap_or_else(|| env::panic_str("no such listing"));
        require!(listing.active, "listing already closed");

        let now_ns = env::block_timestamp();
        let ttl_ns = LISTING_TTL_SECONDS * 1_000_000_000;
        require!(
            now_ns.saturating_sub(listing.created_ns) >= ttl_ns,
            "listing has not expired yet"
        );

        listing.active = false;
        self.listings.replace(index, &listing);

        let mut item = self.items.get(&listing.item_id).unwrap();
        item.listed_supply = item.listed_supply.saturating_sub(listing.units);
        self.items.insert(&listing.item_id, &item);

        // The units go back to the seller, so an expired listing costs the
        // seller nothing but the wait.
        let key = (listing.seller.clone(), listing.item_id.clone());
        let held = self.player_holdings.get(&key).unwrap_or(0);
        self.player_holdings.insert(&key, &(held + listing.units));

        env::log_str(&format!(
            "expire_listing: {} {} units returned to {}",
            listing.units, listing.item_id, listing.seller
        ));
    }

    // -------------------------------------------------------------- NPC trades

    /// An NPC buys from a player listing.
    ///
    /// Called by the backend with the NPC's function-call key. The backend
    /// has already validated the decision; this function validates the
    /// *economics* — price sanity, funds, rate limit — because those are the
    /// things a compromised decision engine must not be able to override.
    #[payable]
    pub fn npc_buy(&mut self, npc_id: String, listing_index: u64, units: u64) -> Promise {
        // Buying adds to the NPC's inventory, which is new contract storage.
        // The caller covers it, or the contract runs out of NEAR to store its
        // own state and every later trade traps.
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(LISTING_STORAGE_COST),
            "attach the storage cost of the inventory"
        );
        self.require_registered_npc_caller(&npc_id);
        require!(units >= MIN_ORDER_UNITS, "order too small");
        require!(units <= MAX_ORDER_UNITS, "order too large");

        let mut listing = self
            .listings
            .get(listing_index)
            .unwrap_or_else(|| env::panic_str("no such listing"));
        require!(listing.active, "listing closed");
        require!(listing.units >= units, "not enough units listed");

        // A listing past its TTL is dead supply: it drags the price down
        // while nobody may buy it. Refuse it here so the seller has to
        // re-list at the current price rather than the market being stuck.
        let ttl_ns = LISTING_TTL_SECONDS * 1_000_000_000;
        require!(
            env::block_timestamp().saturating_sub(listing.created_ns) < ttl_ns,
            "listing has expired"
        );
        require!(
            listing.seller != env::predecessor_account_id(),
            "self-trade refused"
        );

        // Band-check against the fair price *now*, not the one captured when
        // the listing was created. A listing priced fairly at creation becomes
        // an overpay once the market moves, and refusing it then is the whole
        // point of the band: it stops an NPC from buying stale inventory at a
        // price the market no longer supports.
        // The band is checked against the fair price now. A listing priced
        // fairly at creation can drift above the band as the market moves,
        // and that listing is simply stale — it is closed rather than sold,
        // so the seller can re-list at the current price instead of the
        // market being stuck with inventory nobody may buy.
        let fair_now = self.fair_price_of(&listing.item_id);
        let ceiling = fair_now.saturating_mul(BPS + MAX_OVERPAY_BPS) / BPS;
        env::log_str(&format!(
            "npc_buy: ask={} fair_now={} ceiling={}",
            listing.ask_price, fair_now, ceiling
        ));
        require!(
            listing.ask_price <= ceiling,
            "ask price is too far above fair price"
        );

        let mut npc = self.npcs.get(&npc_id).unwrap();
        env::log_str(&format!("npc_buy: npc={} treasury={}", npc_id, npc.treasury));
        self.check_rate_limit(&mut npc);

        // The NPC may only deploy a fraction of its non-reserved treasury.
        let spendable = npc
            .treasury
            .saturating_mul(BPS.saturating_sub(npc.reserve_bps))
            / BPS;
        // ask_price is scaled (see PRICE_SCALE); convert to yoctoNEAR.
        let cost = listing
            .ask_price
            .saturating_mul(units as u128)
            .saturating_mul(ONE_NEAR)
            / PRICE_SCALE;
        env::log_str(&format!("npc_buy: cost={} spendable={}", cost, spendable));
        require!(cost <= spendable, "npc cannot afford this");

        // Settle.
        npc.treasury = npc.treasury.saturating_sub(cost);
        npc.add_units(&listing.item_id, units, listing.ask_price);
        npc.trades += 1;
        npc.window_trades += 1;
        self.npcs.insert(&npc_id, &npc);

        // Close or shrink the listing.
        listing.units -= units;
        if listing.units == 0 {
            listing.active = false;
        }
        self.listings.replace(listing_index, &listing);

        // Update market counters: this is what moves the price.
        let mut item = self.items.get(&listing.item_id).unwrap();
        item.npc_buy_volume += units;
        item.listed_supply = item.listed_supply.saturating_sub(units);
        self.items.insert(&listing.item_id, &item);

        self.record_trade(TradeRecord {
            kind: "npc_buy".to_string(),
            npc_id: npc_id.clone(),
            counterparty: listing.seller.clone(),
            item_id: listing.item_id.clone(),
            units,
            price: listing.ask_price,
            fair_price: listing.fair_at_list,
            at_ns: env::block_timestamp(),
        });

        // Real money moves to the seller. The contract must actually hold it:
        // a transfer it cannot cover traps the whole call, which reads as
        // "the NPC cannot trade" rather than "the vault is short".
        let available = env::account_balance()
            .as_yoctonear()
            .saturating_sub(self.storage_reserve());
        require!(
            cost <= available,
            "the contract cannot cover this payout right now"
        );

        Promise::new(listing.seller).transfer(NearToken::from_yoctonear(cost))
    }

    /// An NPC posts (or updates) its ask for an item.
    ///
    /// This does not move money: a sale needs a buyer, and the buyer is a
    /// player calling `buy_from_npc`. An earlier version credited the NPC's
    /// treasury here with no payment at all, which let an NPC mint money by
    /// "selling" to nobody. Now the NPC only names its price; the contract
    /// bounds that price, and the money moves when someone actually pays it.
    #[payable]
    pub fn npc_sell(&mut self, npc_id: String, item_id: String, units: u64, ask_price: U128) {
        self.require_registered_npc_caller(&npc_id);
        require!(units >= MIN_ORDER_UNITS, "order too small");
        require!(units <= MAX_ORDER_UNITS, "order too large");

        let fair = self.fair_price_of(&item_id);
        let floor = fair.saturating_mul(BPS.saturating_sub(MAX_UNDERCUT_BPS)) / BPS;
        // Only a floor: an ask above fair just goes unsold, which costs the
        // NPC nothing. An ask far below fair is a giveaway and is refused.
        require!(ask_price.0 >= floor, "ask price is too far below fair price");

        let mut npc = self.npcs.get(&npc_id).unwrap();
        self.check_rate_limit(&mut npc);
        require!(
            npc.units_of(&item_id) >= units,
            "npc does not hold that many units"
        );
        npc.set_ask(&item_id, ask_price.0);
        npc.window_trades += 1;
        self.npcs.insert(&npc_id, &npc);

        env::log_str(&format!(
            "npc_sell: {} asks {} for {} (fair {})",
            npc_id, ask_price.0, item_id, fair
        ));
    }

    /// A player buys units from an NPC at the NPC's posted ask.
    ///
    /// `max_price` is the buyer's slippage guard: the most they will pay per
    /// unit. The price itself is the NPC's — a buyer who could name the price
    /// could buy at the bottom of the band and resell at fair, draining the
    /// NPC on every round trip.
    #[payable]
    pub fn buy_from_npc(&mut self, npc_id: String, item_id: String, units: u64, max_price: U128) {
        require!(units >= MIN_ORDER_UNITS, "order too small");
        require!(units <= MAX_ORDER_UNITS, "order too large");

        let key = npc_id.clone();
        let mut npc = self
            .npcs
            .get(&key)
            .unwrap_or_else(|| env::panic_str("unknown npc"));
        let price = npc
            .ask_of(&item_id)
            .unwrap_or_else(|| env::panic_str("npc is not selling this item"));
        require!(price <= max_price.0, "npc ask is above your max price");

        // The ask was inside the band when posted; the market may have moved
        // since. A stale ask below the band is refused rather than sold.
        let fair = self.fair_price_of(&item_id);
        let floor = fair.saturating_mul(BPS.saturating_sub(MAX_UNDERCUT_BPS)) / BPS;
        require!(price >= floor, "npc ask is stale, too far below fair price");

        require!(
            npc.units_of(&item_id) >= units,
            "npc does not hold that many units"
        );

        let buyer = env::predecessor_account_id();
        let cost = price * units as u128 * ONE_NEAR / PRICE_SCALE;
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "attach at least the cost of the units");

        npc.consume_fifo(&item_id, units, price);
        npc.treasury += cost;
        npc.trades += 1;
        self.npcs.insert(&key, &npc);

        // The buyer gets the fish. (An earlier version took the payment and
        // removed the NPC's stock but never credited the buyer.)
        let hk = (buyer.clone(), item_id.clone());
        let held = self.player_holdings.get(&hk).unwrap_or(0);
        self.player_holdings.insert(&hk, &(held + units));

        let mut item = self.items.get(&item_id).unwrap();
        self.roll_window(&mut item);
        item.npc_sell_volume += units;
        item.player_buy_volume += units;
        self.items.insert(&item_id, &item);

        self.record_trade(TradeRecord {
            kind: "player_buy".to_string(),
            npc_id: npc_id.clone(),
            counterparty: buyer.clone(),
            item_id: item_id.clone(),
            units,
            price,
            fair_price: fair,
            at_ns: env::block_timestamp(),
        });

        if attached > cost {
            let _ = Promise::new(buyer).transfer(NearToken::from_yoctonear(attached - cost));
        }
    }

    // ----------------------------------------------------------- investment

    /// Invest NEAR into an NPC. The principal is the attached deposit and
    /// joins the NPC's treasury, so it is real capital the NPC trades with.
    ///
    /// `amount` must equal the attached deposit. An earlier version trusted
    /// `amount` alone, so anyone could "invest" 1000 NEAR without paying and
    /// withdraw it as real NEAR after the cooldown.
    #[payable]
    pub fn invest(&mut self, npc_id: String, amount: U128) {
        let mut npc = self
            .npcs
            .get(&npc_id)
            .unwrap_or_else(|| env::panic_str("unknown npc"));
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached > 0, "attach the NEAR you want to invest");
        require!(amount.0 == attached, "amount must equal the attached deposit");

        let investor = env::predecessor_account_id();
        let mut inner = self
            .investors
            .get(&npc_id)
            .unwrap_or_else(|| LookupMap::new(StorageKey::InvestorsOf { npc: npc_id.clone() }));
        let unlock_ns = env::block_timestamp() + INVESTOR_COOLDOWN_SECONDS * 1_000_000_000;

        let inv = match inner.get(&investor) {
            Some(mut inv) => {
                // Topping up while profit is unclaimed would let a small early
                // stake be scaled up after the fact to claim profit it never
                // financed. Claim first, then add.
                require!(
                    Self::owed_scaled(&npc, &inv) <= 0,
                    "claim your profit before adding more"
                );
                inv.principal += attached;
                inv.entry_profit = npc.realized_profit;
                inv.claimed = 0;
                inv.unlock_ns = unlock_ns;
                inv
            }
            None => Investment {
                principal: attached,
                share_bps: 3_000, // pool share: investors together take 30%
                entry_profit: npc.realized_profit,
                unlock_ns,
                claimed: 0,
            },
        };
        inner.insert(&investor, &inv);
        self.investors.insert(&npc_id, &inner);

        npc.treasury += attached;
        npc.invested_total += attached;
        self.npcs.insert(&npc_id, &npc);
    }

    /// Profit owed to an investor in scaled units, before what they already
    /// claimed. Pro rata: the 30% pool is split by principal, so the shares
    /// of every investor together can never exceed 30% of the gain.
    fn owed_scaled(npc: &Npc, inv: &Investment) -> i128 {
        if npc.invested_total == 0 || inv.principal == 0 {
            return 0;
        }
        let gain = npc.realized_profit - inv.entry_profit;
        if gain <= 0 {
            return 0;
        }
        let pool = gain as u128 * inv.share_bps / BPS;
        let mine = pool * inv.principal / npc.invested_total;
        mine as i128 - inv.claimed
    }

    /// Withdraw realized profit share. The payout comes out of the NPC's
    /// treasury, so the contract never pays money it does not owe.
    pub fn claim_profit(&mut self, npc_id: String) -> Promise {
        let investor = env::predecessor_account_id();
        let mut inner = self
            .investors
            .get(&npc_id)
            .unwrap_or_else(|| env::panic_str("no investment"));
        let mut inv = inner
            .get(&investor)
            .unwrap_or_else(|| env::panic_str("no investment"));
        let mut npc = self.npcs.get(&npc_id).unwrap();

        let payable = Self::owed_scaled(&npc, &inv);
        require!(payable > 0, "no profit to claim");

        // Scaled units (NEAR * PRICE_SCALE) back to yoctoNEAR.
        let yocto = payable as u128 * ONE_NEAR / PRICE_SCALE;
        require!(npc.treasury >= yocto, "npc treasury cannot cover the payout");
        npc.treasury -= yocto;
        self.npcs.insert(&npc_id, &npc);

        inv.claimed += payable;
        inner.insert(&investor, &inv);
        self.investors.insert(&npc_id, &inner);

        Promise::new(investor).transfer(NearToken::from_yoctonear(yocto))
    }

    /// Withdraw principal after the cooldown. If the NPC has lost money the
    /// investor gets at most what is left, never someone else's funds.
    pub fn withdraw_principal(&mut self, npc_id: String) -> Promise {
        let investor = env::predecessor_account_id();
        let mut inner = self
            .investors
            .get(&npc_id)
            .unwrap_or_else(|| env::panic_str("no investment"));
        let mut inv = inner
            .get(&investor)
            .unwrap_or_else(|| env::panic_str("no investment"));

        require!(
            env::block_timestamp() >= inv.unlock_ns,
            "principal is still locked"
        );
        require!(inv.principal > 0, "nothing to withdraw");

        let mut npc = self.npcs.get(&npc_id).unwrap();
        let amount = inv.principal.min(npc.treasury);
        npc.treasury -= amount;
        npc.invested_total = npc.invested_total.saturating_sub(inv.principal);
        self.npcs.insert(&npc_id, &npc);

        inv.principal = 0;
        inner.insert(&investor, &inv);
        self.investors.insert(&npc_id, &inner);

        Promise::new(investor).transfer(NearToken::from_yoctonear(amount))
    }

    // ------------------------------------------------------------------ views

    pub fn get_item(&self, id: String) -> Option<Item> {
        self.items.get(&id)
    }

    pub fn get_npc(&self, id: String) -> Option<Npc> {
        self.npcs.get(&id)
    }

    pub fn all_items(&self) -> Vec<Item> {
        self.items.values().collect()
    }

    /// Every item with its live fair price. One call for a full market view.
    pub fn market_snapshot(&self) -> Vec<ItemView> {
        self.items
            .values()
            .map(|mut item| {
                // Same window roll the write path uses, so the snapshot and
                // the contract agree on the price.
                self.roll_window(&mut item);
                let npc_stock = self.npc_inventory_of(item.id.clone());
                ItemView {
                    id: item.id.clone(),
                    rarity: item.rarity,
                    utility: item.utility,
                    name: item.name.clone(),
                    base_price: item.base_price,
                    fair_price: item.fair_price(npc_stock),
                    listed_supply: item.listed_supply,
                    npc_buy_volume: item.npc_buy_volume,
                    npc_sell_volume: item.npc_sell_volume,
                    player_buy_volume: item.player_buy_volume,
                    npc_inventory: npc_stock,
                    event_modifier_bps: item.event_modifier_bps,
                    event_label: item.event_label.clone(),
                }
            })
            .collect()
    }

    pub fn all_npcs(&self) -> Vec<Npc> {
        self.npcs.values().collect()
    }

    /// The deterministic fair price of an item right now.
    pub fn fair_price(&self, item_id: String) -> U128 {
        U128(self.fair_price_of(&item_id))
    }

    /// Total units of an item held across all NPCs — the scarcity input.
    pub fn npc_inventory_of(&self, item_id: String) -> u64 {
        self.npcs
            .iter()
            .map(|(_, n)| n.units_of(&item_id))
            .sum()
    }

    /// Open listings, each carrying its global index.
    ///
    /// The index matters: `npc_buy` looks a listing up by its position in the
    /// full vector, including closed ones. Returning only the active ones
    /// without their real index makes a caller ask for the wrong listing --
    /// the engine picks index 2 and the contract reads a different, closed or
    /// overpriced entry.
    pub fn open_listings(&self) -> Vec<(u64, Listing)> {
        self.listings
            .iter()
            .enumerate()
            .filter(|(_, l)| l.active)
            .map(|(i, l)| (i as u64, l))
            .collect()
    }

    pub fn recent_trades(&self, limit: u32) -> Vec<TradeRecord> {
        let len = self.trade_log.len() as u32;
        let start = len.saturating_sub(limit);
        (start..len)
            .rev()
            .filter_map(|i| self.trade_log.get(i as u64))
            .collect()
    }

    pub fn investment_of(&self, npc_id: String, investor: AccountId) -> Option<Investment> {
        self.investors
            .get(&npc_id)
            .and_then(|inner| inner.get(&investor))
    }

    // --------------------------------------------------------------- internal

    /// Append a trade to the log, keeping only the most recent entries.
    ///
    /// The log is a UI feed, not an audit trail — an unbounded Vector makes
    /// the contract's storage grow with every trade until it can no longer
    /// afford to store its own state. Capping it keeps storage flat.
    fn record_trade(&mut self, record: TradeRecord) {
        // Drop from the *front* with pop_front semantics: Vector::swap_remove
        // leaves the old entry on chain, so the contract's storage grows with
        // every trade no matter how small MAX_TRADE_LOG is. Rebuilding the
        // vector is what actually frees the bytes.
        self.trade_log.push(&record);
        let len = self.trade_log.len();
        if len > MAX_TRADE_LOG {
            let keep: Vec<TradeRecord> = self
                .trade_log
                .iter()
                .skip((len - MAX_TRADE_LOG) as usize)
                .collect();
            self.trade_log.clear();
            for r in &keep {
                self.trade_log.push(r);
            }
        }
    }

    fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    /// Decode a base58 "ed25519:..." key or signature into raw bytes.
    ///
    /// env::ed25519_verify works on raw bytes, while keys and signatures
    /// travel as base58 strings. Base58 is decoded here rather than through a
    /// crate because every crypto crate for wasm drags in a C cross-compile.
    fn decode_ed25519(value: &str, err: &str) -> Vec<u8> {
        const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        let raw = value.strip_prefix("ed25519:").unwrap_or(value);

        // Big-endian accumulation: each digit multiplies the running value by
        // 58. The result is built least-significant-first, then reversed.
        let mut digits: Vec<u8> = Vec::new();
        for ch in raw.bytes() {
            let digit = ALPHABET
                .iter()
                .position(|&a| a == ch)
                .unwrap_or_else(|| env::panic_str(err));
            let mut carry = digit as u32;
            for d in digits.iter_mut() {
                carry += (*d as u32) * 58;
                *d = (carry & 0xff) as u8;
                carry >>= 8;
            }
            while carry > 0 {
                digits.push((carry & 0xff) as u8);
                carry >>= 8;
            }
        }

        // Leading '1's encode leading zero bytes.
        let zeros = raw.bytes().take_while(|&c| c == b'1').count();
        let mut bytes = vec![0u8; zeros];
        bytes.extend(digits.iter().rev());
        bytes
    }

    /// The caller must be the NPC's own account. NPC keys are function-call
    /// keys scoped to this contract, so this is the only way an NPC can act.
    fn require_registered_npc_caller(&self, npc_id: &str) {
        let key = npc_id.to_string();
        let npc = self
            .npcs
            .get(&key)
            .unwrap_or_else(|| env::panic_str("unknown npc"));
        let caller = env::predecessor_account_id();
        let as_sub = npc_id_as_account(npc_id);
        let as_name: AccountId = npc.name.parse().unwrap_or_else(|_| caller.clone());
        require!(
            caller == as_sub || caller == as_name,
            "caller is not this npc"
        );
    }

    /// Enforce the per-NPC trade rate limit, resetting the window when it
    /// has rolled over.
    fn check_rate_limit(&self, npc: &mut Npc) {
        let now = env::block_timestamp();
        let window_ns = TRADE_WINDOW_SECONDS * 1_000_000_000;
        if now.saturating_sub(npc.window_start_ns) >= window_ns {
            npc.window_start_ns = now;
            npc.window_trades = 0;
        }
        require!(
            npc.window_trades < MAX_TRADES_PER_WINDOW,
            "npc trade rate limit reached"
        );
    }

    /// Apply the pricing-window roll to an item's volumes.
    ///
    /// Volumes older than the window stop counting, so the price tracks
    /// recent activity. This is the single place the roll happens: if a view
    /// and a write rolled differently they would disagree on the price, and
    /// an NPC deciding against the view's number would have its trade
    /// refused by the write's.
    fn roll_window(&self, item: &mut Item) {
        let now_ns = env::block_timestamp();
        let window_ns = PRICING_WINDOW_SECONDS * 1_000_000_000;
        if now_ns.saturating_sub(item.window_start_ns) >= window_ns {
            item.npc_buy_volume = 0;
            item.npc_sell_volume = 0;
            item.player_buy_volume = 0;
            item.vault_intake = 0;
            item.window_start_ns = now_ns;
        }
    }

    fn fair_price_of(&self, item_id: &str) -> u128 {
        let key = item_id.to_string();
        let mut item = self
            .items
            .get(&key)
            .unwrap_or_else(|| env::panic_str("unknown item"));
        self.roll_window(&mut item);
        let npc_stock = self.npc_inventory_of(item_id.to_string());
        item.fair_price(npc_stock)
    }
}

/// Personality parameters for an NPC. Stored as constants at registration;
/// the decision engine reads them but can never change them.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Personality {
    pub buy_tolerance_bps: u128,
    pub sell_tolerance_bps: u128,
    pub aggression_bps: u128,
    pub reserve_bps: u128,
    pub min_edge_bps: u128,
}

/// NPC ids map to sub-accounts of this contract, e.g. "bob" -> "bob.divemarket".
fn npc_id_as_account(npc_id: &str) -> AccountId {
    let contract = env::current_account_id();
    let sub = format!("{}.{}", npc_id, contract);
    sub.parse().unwrap_or(contract)
}








