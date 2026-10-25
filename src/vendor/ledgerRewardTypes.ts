// Every reward_type a Rewards row may carry (ledger master plan, Stage B4).
// The ledger verifier flags any row whose type is not listed here, so a
// new earn or spend path must add its type in the same commit. Legacy
// types stay listed so their historical rows keep verifying.
export const LEDGER_REWARD_TYPES = [
  // Platform rewards (USD-anchored, tiered for free members)
  "DAILY_CHECKIN",
  "TIME_ON_PLATFORM",
  "TOOLTIP_EARN",
  "REFERRAL_CODE_CREATION",
  "REFERRAL_ONBOARD",
  "VOLUME_GENERATION",
  "SHARE_BETTER",
  "SHARE_BETTER_REVOKED",
  "SHARE_SOCIAL",
  "CREATOR_SIGNUP",
  "PREMIUM_LISTING",
  "TX_PASSWORD_SET",
  "RECOVERY_EMAIL_SET",
  "YUBIKEY_CONNECT",
  "X_VERIFIED",
  "YOUTUBE_VERIFIED",
  "PRO_SIGNUP",
  "LEADERBOARD_BONUS",
  // Early adopter campaign
  "EARLY_ADOPTER_BONUS",
  "EARLY_ADOPTER_RESET",
  // Purchases, Pro and fees
  "BTR_PURCHASE",
  // Admin-resolved refund or dispute of a BTR_PURCHASE (master plan F3):
  // sign -1, source_id = the PaymentIntent id.
  "BTR_PURCHASE_REVERSAL",
  // Admin-resolved refund or chargeback of a card-paid Pro membership or
  // identity fee: takes back its rebate (sign -1, source_id = the rebate's).
  "CARD_REBATE_REVERSAL",
  "PRO_PURCHASE",
  "PRO_RENEWAL_BONUS",
  "VERIFICATION_FEE_REBATE",
  // Gold Nº bought by card (2026-10-24): the price back in $BTR, once per
  // account, source_id stripe_gold:<PaymentIntent id>.
  "GOLD_MEMBERSHIP_REBATE",
  // Funded bounties (escrow) and their reversals
  "DAPP_BOUNTY",
  "DAPP_BOUNTY_REVOKED",
  "CREATOR_BOUNTY",
  "CREATOR_BOUNTY_REVOKED",
  "BTR_SPEND_BOUNTY_CLAIM",
  "BTR_SPEND_BOUNTY_CLAIM_REVOKED",
  "BTR_SPEND_CREATOR_BOUNTY",
  "BTR_SPEND_CREATOR_BOUNTY_REVOKED",
  // Partake
  "PARTAKE_CLAIM",
  "BTR_SPEND_PARTAKE",
  // Creator Services (2026-10-14): on release the buyer is debited the
  // paid amount, the creator credited it minus the 5% fee. source_id = order.
  "CREATOR_SERVICE",
  "BTR_SPEND_CREATOR_SERVICE",
  // Spends: store, events, handles, Legends
  "STORE_PURCHASE",
  "STORE_CREDIT",
  "EVENT_BOOST",
  "REFERRAL_CODE_PURCHASE",
  "REFERRAL_STAMP_PURCHASE",
  "REFERRAL_STAMP_RETRIES",
  "REFERRAL_STAMP_EYES",
  // Legacy: no longer written, kept so old rows verify
  "PRO_REFERRER_BONUS",
  "REFERRAL_STAMP_WREATH",
  "IRL_BOUNTY",
  "BTR_SPEND_IRL_BOUNTY",
  "BTR_SPEND_IRL_CANCEL",
  // Tip a friend (2026-10-20): paired rows, same source_id "tip:<uuid>".
  "TIP_SENT",
  "TIP_RECEIVED",
] as const;

export type LedgerRewardType = (typeof LEDGER_REWARD_TYPES)[number];
