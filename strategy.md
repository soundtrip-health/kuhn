# AGPL Commercialization Strategy: AI-Powered TeXlyre Webapp

## 1. The AGPL "SaaS Loophole" & Compliance
The AGPL-3.0 license requires that if you modify the software and run it on a server for users to interact with over a network, you **must make your modified source code available** to those users.

* **Requirement:** If you change TeXlyre's frontend or core logic, you must provide a link to the source code of your modified version.
* **Strategy:** Maintain a public fork on GitHub for your TeXlyre modifications.

## 2. Architectural "Firewall" (Protecting Proprietary IP)
To keep your core AI Agent logic proprietary, use a **Service-Oriented Architecture (SOA)**.

* **Frontend (AGPL):** The UI, editor, and API "plumbing" reside here. This part is open source.
* **The API Boundary:** Use standard protocols (REST/gRPC) to talk to your backend. This acts as a legal "arm's length" boundary.
* **Backend (Proprietary):** Your specialized AI agents, prompts, and orchestration logic live here. As long as they are separate programs communicating via a network, they are generally not considered "derivative works" of the AGPL code.

## 3. The "Open Core" Business Model
Emulate the Overleaf model to build trust within the scientific community.

* **Community Edition:** Open-source your "API hooks" and perhaps a basic backend that allows users to use their own LLM keys.
* **Pro Edition:** Offer your hosted, high-performance AI agents as a subscription service.
* **Frontend LLMs:** Small, local-first LLM features integrated into the UI should be released as part of your TeXlyre fork/contributions.

## 4. Strategic Recommendations
* **Contribute Back:** Aim to merge your "API hooks" into the main TeXlyre repo to reduce maintenance overhead and satisfy disclosure rules.
* **Avoid Tight Coupling:** Ensure the frontend can technically function with other backends (even if limited). This proves the components are independent.
* **Investor Readiness:** Maintain clear architectural diagrams showing the separation between the AGPL "Editor" and the proprietary "Intelligence" to address IP concerns during due diligence.

## 5. Summary Table

| Component | License | Visibility |
| :--- | :--- | :--- |
| **TeXlyre Core/UI** | AGPL-3.0 | Public Fork |
| **API Hooks** | AGPL-3.0 | Public Fork / Upstream |
| **Local LLM Code** | AGPL-3.0 | Public Fork |
| **AI Agent Logic** | Proprietary | Private |
| **Agent Data/Prompts** | Proprietary | Private |
