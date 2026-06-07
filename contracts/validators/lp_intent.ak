//// The LP-intent validator (BLUEPRINT §5.1/§5.4 Rev 22) — **parameterised by the
//// settlement credential `S`** (like the order/pool validators). It binds the pool by
//// its unique NFT (so it needs the pool hash from no one), but it DOES need `S` to assert
//// a fulfillment is **never folded into a settlement** (`Fulfill -> !withdrawal_present(S)`,
//// which forces the pool-spend to be `LpAction` and so runs the per-share backing — see
//// `shaswap/lp_intent`). Thin wrapper over `shaswap/lp_intent`: `Fulfill` is a
//// batcher-fulfilled deposit/withdraw (a self-contained tx), `ReclaimLp` is
//// owner-signature-only (§5.1). It joins the immutable deployment set as a NEW hash; the
//// settlement/order/pool/pool_mint hashes are unchanged.

use cardano/address.{Credential}
use cardano/transaction.{OutputReference, Transaction}
use shaswap/lp_intent as fulfillment
use shaswap/lp_intent_types.{
  Fulfill, LpIntentDatum, LpIntentRedeemer, ReclaimLp,
}

validator lp_intent(settlement_cred: Credential) {
  spend(
    datum: Option<LpIntentDatum>,
    redeemer: LpIntentRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    expect Some(d) = datum
    when redeemer is {
      Fulfill -> fulfillment.fulfill(self, utxo, d, settlement_cred)
      ReclaimLp -> fulfillment.reclaim(d.owner, self)
    }
  }

  else(_) {
    fail
  }
}
