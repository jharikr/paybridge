# Use each merchant's own provider credentials

Paybridge's intended users are independent merchants in Anguilla that have their own NCBA/4Cs merchant keys. Provider operations must use the owning merchant's credentials, so a merchant and the application integrating on its behalf are separate concepts; a single shared provider credential would not demonstrate the intended account boundary.

The proof of concept uses synthetic credentials. Self-service signup and key submission belong to the product direction, while the reference implementation retains seeded configuration.
