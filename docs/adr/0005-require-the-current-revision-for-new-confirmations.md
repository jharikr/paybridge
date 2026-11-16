# Require the current revision for new confirmations

Each new confirmation must identify the payment revision on which it is based. Paybridge checks that revision atomically with the existing state and attempt guards, so a delayed command sent before a decline cannot silently become another payment attempt after that decline.

Authenticate and match the command's identity before applying this guard: an identical completed command still returns its original cached acknowledgement, even when the payment has since changed. The sample caller refreshes after a stale-state conflict and requires a deliberate new confirmation; refreshing and automatically resubmitting the old instruction would defeat the decision.
