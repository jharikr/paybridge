# Separate checkout navigation from cancellation

A payer returning to the merchant from checkout leaves the payment intent's state unchanged. Reserve terminal cancellation for an explicit merchant action before processing starts, so backing out of checkout does not permanently prevent the payer from returning to pay.

This changes the draft's checkout cancel behavior, which reused the merchant cancellation operation. The proof of concept demonstrates the distinction through its headless HTTP flow; leaving checkout never cancels an in-flight provider operation.

After an explicit merchant cancellation, the sample retains the cancelled intent and its order binding. Replacing it with another intent for the same order is outside this prototype; the sample never erases the cancelled payment's history.
