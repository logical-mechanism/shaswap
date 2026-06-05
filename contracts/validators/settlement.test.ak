//// Validator-entrypoint tests for the settlement trust anchor (audit I-06).
//// These drive the real `settlement.publish` handler through the validator wrapper
//// (not just the `clearing.allow_registration` lib function it delegates to), so the
//// dispatch wiring of the immortal withdraw-0 anchor's certificate authority is
//// actually exercised under a constructed context — the gap the audit flagged
//// ("redeemer dispatch never driven through a validator").

use cardano/address.{Credential, Script}
use cardano/certificate.{
  AlwaysAbstain, DelegateCredential, DelegateVote, RegisterCredential,
  UnregisterCredential,
}
use cardano/transaction
use settlement

const s_hash = #"5555555555555555555555555555555555555555555555555555555a"

fn s() -> Credential {
  Script(s_hash)
}

// `publish` ACCEPTS registration of S — the only path that brings the anchor into
// existence (so the withdraw-0 trick can ever validate).
test settlement_publish_accepts_register() {
  settlement.settlement.publish(
    0,
    RegisterCredential { credential: s(), deposit: Never },
    transaction.placeholder,
  )
}

// `publish` REJECTS de-registration: a griefer must never un-register S and brick
// every settlement forever.
test settlement_publish_rejects_unregister() fail {
  settlement.settlement.publish(
    0,
    UnregisterCredential { credential: s(), refund: Never },
    transaction.placeholder,
  )
}

// `publish` REJECTS delegation: S stays undelegatable, so its always-zero rewards
// can never be captured.
test settlement_publish_rejects_delegate() fail {
  settlement.settlement.publish(
    0,
    DelegateCredential {
      credential: s(),
      delegate: DelegateVote { delegate_representative: AlwaysAbstain },
    },
    transaction.placeholder,
  )
}
