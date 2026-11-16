# Keep order identity with the merchant

The merchant application owns the relationship between its business obligation and a Paybridge payment intent. It persists and reuses that intent and stable command keys across interrupted checkout and retries; Paybridge prevents duplicate successful collection within the intent but does not infer business uniqueness across separate intents from merchant_reference.

This retains the reference plan's division of responsibility without imposing one order model on every merchant. The sample must prove its order binding survives retries and restarts. The prototype retains the binding to an explicitly cancelled intent and does not implement a replacement payment for that same sample order.
