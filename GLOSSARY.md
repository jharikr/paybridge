# Paybridge

Paybridge provides hosted checkout for merchants in Anguilla using their own NCBA/4Cs merchant credentials. The current work is a simulated proof of concept of that service.

## Language

**Merchant**:
A person or organisation receiving payments through Paybridge using its own bank-issued provider merchant key.
_Avoid_: Client system, merchant application

**Merchant application**:
A website or other system that integrates with Paybridge on a merchant's behalf.
_Avoid_: Merchant

**Payer**:
The person making a payment to a merchant through checkout.
_Avoid_: User when the distinction from a merchant matters

**Provider merchant key**:
The bank-issued credential identifying the merchant's account to 4Cs. It is distinct from a credential used to access Paybridge.
_Avoid_: API key without specifying the service

**Hosted checkout**:
The payment experience Paybridge provides to a merchant's payers in place of the merchant building its own checkout integration with 4Cs.

**Payment intent**:
A merchant's request to collect a fixed amount in a specified currency. The merchant application associates it with the order or other obligation being paid.
_Avoid_: Order, payment attempt

**Payment attempt**:
One attempt to collect the amount requested by a payment intent. A definite failure can be followed by another attempt on the same intent.
_Avoid_: Payment intent, individual request transmission

**Merchant reference**:
The merchant's business reference attached to a payment intent. It does not by itself establish that two intents represent the same obligation.
_Avoid_: Globally unique order identity

**Cancellation**:
A merchant's permanent withdrawal of a payment intent before financial processing starts. A payer leaving checkout does not constitute cancellation.
_Avoid_: Leaving checkout, bank decline

**Unknown outcome**:
A payment attempt whose financial result has not been established. It is neither a confirmed payment nor a definite failure.
_Avoid_: Failed payment, unpaid payment

**Reconciliation**:
The investigation of an unknown payment outcome using evidence of what happened to the attempt. Resolution establishes success or definite non-payment; inconclusive evidence leaves the outcome unknown.
_Avoid_: Retrying the payment, automatically declaring failure
