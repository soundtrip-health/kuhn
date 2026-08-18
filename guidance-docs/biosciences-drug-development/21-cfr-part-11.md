# 21 CFR Part 11 — Electronic Records; Electronic Signatures

> **Kuhn knowledge card.** Canonical source: https://www.ecfr.gov/current/title-21/part-11 (U.S. Code of Federal Regulations, FDA). Source access/license: free, official U.S. regulatory text; U.S. government works are public domain. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

21 CFR Part 11 is the FDA regulation establishing when **electronic records and electronic signatures are trustworthy, reliable, and equivalent to paper records and handwritten signatures**. It applies to records in electronic form that are created, modified, maintained, archived, retrieved, or transmitted under any FDA "predicate rule" — the underlying GxP regulations that require the record in the first place (e.g., GLP under 21 CFR 58, GCP/IND rules, GMP under 21 CFR 210/211). In drug development it governs electronic data capture (EDC) systems, eCRFs, LIMS, chromatography data systems, electronic lab notebooks, eTMFs, instrument software, and e-signature workflows.

Part 11 does *not* create record-keeping requirements of its own; it sets conditions on records the predicate rules already require. FDA's 2003 "Scope and Application" guidance narrows enforcement to a risk-based interpretation (e.g., enforcement discretion on validation, audit trails, record retention and copying for some legacy/low-risk cases), but the controls below remain the recognized standard.

## Key requirements

Paraphrased structure of the regulation:

- **Subpart A — General.** Defines scope, definitions (electronic record, electronic signature, digital signature, closed vs open system), and the rule that electronic records/signatures meeting Part 11 are equivalent to paper and handwritten counterparts. Systems are "closed" when access is controlled by the people responsible for the records; "open" otherwise.
- **Subpart B — Controls for electronic records.** For closed systems, required procedures and controls include:
  - **Validation** of the system to ensure accuracy, reliability, consistent intended performance, and the ability to discern invalid or altered records.
  - **Accurate and complete copies** of records in both human-readable and electronic form suitable for FDA inspection.
  - **Record protection and retention** so records remain accurate and readily retrievable throughout the required retention period.
  - **Access limited to authorized individuals** (logical security).
  - **Secure, computer-generated, time-stamped audit trails** that independently record the date and time of operator entries and of actions that create, modify, or delete records — without obscuring previously recorded information; audit trails are retained at least as long as the records and are available for review and copying.
  - **Operational, authority, and device checks** — enforced sequencing of steps where required, checks that only authorized individuals can use the system, sign, or alter records, and checks on the validity of data-input sources.
  - **Personnel qualifications and accountability** — persons who develop, maintain, or use the systems have the education, training, and experience to do so, and written policies hold individuals responsible for actions initiated under their e-signatures.
  - **Documentation controls** — controlled distribution of, and revision/change control over, system operation and maintenance documentation.
  - Open systems require the closed-system controls *plus* additional measures (e.g., encryption, digital-signature standards) to ensure authenticity, integrity, and confidentiality in transit.
- **Signature manifestation.** Signed electronic records must display the signer's printed name, the date/time of signing, and the meaning of the signature (review, approval, responsibility, authorship).
- **Signature/record linking.** Signatures must be inextricably linked to their records so they cannot be excised, copied, or transferred to falsify another record.
- **Subpart C — Electronic signatures.**
  - Each e-signature must be unique to one individual and never reused or reassigned; identity must be verified before assignment.
  - Non-biometric signatures use at least two distinct components (typically user ID + password), with all components required at the first signing of a session and at least one component for subsequent signings; biometric signatures must be usable only by their genuine owner.
  - Organizations must certify to FDA that e-signatures in their systems are intended as the legally binding equivalent of handwritten signatures.
  - Password/ID controls include uniqueness, periodic revision, loss-management and deauthorization procedures, transaction safeguards against unauthorized use, and testing of tokens and cards.

## How to apply when writing

Writers of protocols, study reports, regulatory submissions, and SOP-adjacent documents must be able to *state* the data-system posture accurately:

- **In protocols and data-management plans:** identify the systems used (EDC, ePRO, IxRS, central-lab LIMS), state that they are validated and Part 11-compliant, and describe access control, audit trails, and how source data and corrections are handled.
- **In clinical study reports and publications' methods:** a sentence such as "Data were captured in a validated electronic data capture system with role-based access and computer-generated audit trails, compliant with 21 CFR Part 11" is the conventional formulation — but only write it when the sponsor's system documentation actually supports each clause.
- **In nonclinical/GLP reports:** state that instrument data systems (e.g., chromatography software) maintain electronic raw data with audit trails, and identify what constitutes the raw data (electronic file vs printout).
- **For signatures:** where approvals are electronic, the document should show signer name, date/time, and signature meaning; do not paste image-of-signature graphics and call them e-signatures.
- **Pair with ALCOA+:** FDA's data-integrity guidance (Attributable, Legible, Contemporaneous, Original, Accurate, plus Complete, Consistent, Enduring, Available) is the vocabulary reviewers expect when describing why the electronic records are trustworthy.
- Distinguish claims precisely: "validated" (documented evidence of fitness), "Part 11-compliant" (the controls above), and "predicate-rule-compliant" (the underlying GxP requirement) are three different statements.
- When describing record retention (e.g., trial master files, raw instrument data), state the retention period the predicate rule drives and how records — including their audit trails — remain retrievable after system decommissioning or migration.

## Common pitfalls

- Asserting blanket "Part 11 compliance" for a vendor product — compliance attaches to the *implemented, validated system in use* (configuration, procedures, training), not to software in a box.
- Describing audit trails that can be disabled, edited, or that overwrite prior values — audit trails must be secure, computer-generated, and preserve the original entry.
- Forgetting that Part 11 rides on predicate rules: citing Part 11 for a record no regulation requires, or ignoring the predicate rule's retention period.
- Shared logins or generic accounts — they break attributability and the uniqueness requirement for signatures.
- Omitting the signature *meaning* (review vs approval vs authorship) from signed records.
- Confusing scanned/hybrid paper processes with electronic records, or overlooking the extra controls open systems need.

## Canonical links

- 21 CFR Part 11, current text (eCFR): https://www.ecfr.gov/current/title-21/part-11
- FDA guidance: Part 11, Electronic Records; Electronic Signatures — Scope and Application (2003): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/part-11-electronic-records-electronic-signatures-scope-and-application
- FDA Data Integrity and Compliance guidance (ALCOA+ context): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/data-integrity-and-compliance-cber-and-cder
- 21 CFR Part 58 (GLP) — an example predicate rule: https://www.ecfr.gov/current/title-21/part-58
