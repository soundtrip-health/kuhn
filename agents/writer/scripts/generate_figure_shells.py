#!/usr/bin/env python3
"""
Generate Appendix B figure shells with placeholder data.

Produces publication-quality mock figures for the NRx protocol using
simulated data that reflects the expected shape of results. All values
are illustrative only — no real patient data is used.

Output: figures/figure_b2_{1..5}.png
"""

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns

# ── Global style ────────────────────────────────────────────────────
sns.set_theme(style="whitegrid", font_scale=1.1)
COLORS = {"ket": "#2171B5", "esk": "#CB181D"}
OUTDIR = "figures"
DPI = 300


# ── Figure B2.1: Cohort Flow Diagram ───────────────────────────────
# Generated via Mermaid (figures/figure_b2_1.mmd) using:
#   mmdc -i figures/figure_b2_1.mmd -o figures/figure_b2_1.png -s 3 -b white


# ── Figure B2.2: Covariate Balance (Love Plot) ─────────────────────

def fig_b2_2():
    covariates = [
        "TRD status", "Baseline PHQ-9", "Household income",
        "Ethnicity (Unk/Decl)", "Ethnicity (Hispanic)",
        "Race (Unk/Decl)", "Race (Black)", "Race (White)",
        "Sex (female)", "Age",
    ]
    # Simulated SMDs: before IPTW = moderate imbalance, after = well-balanced
    rng = np.random.default_rng(42)
    smd_before = rng.uniform(-0.35, 0.40, size=len(covariates))
    smd_after = rng.uniform(-0.06, 0.06, size=len(covariates))

    fig, ax = plt.subplots(figsize=(7, 5.5))
    y_pos = np.arange(len(covariates))

    ax.scatter(smd_before, y_pos, marker="o", s=70, color="#999999",
               zorder=3, label="Before IPTW")
    ax.scatter(smd_after, y_pos, marker="D", s=70, color=COLORS["ket"],
               zorder=4, label="After IPTW")

    # Connect before → after with thin lines
    for i in range(len(covariates)):
        ax.plot([smd_before[i], smd_after[i]], [y_pos[i], y_pos[i]],
                color="#CCCCCC", lw=0.8, zorder=2)

    # Acceptable balance zone
    ax.axvspan(-0.1, 0.1, color="#E8F5E9", alpha=0.5, zorder=1)
    ax.axvline(0.1, color="#66BB6A", ls="--", lw=0.8, zorder=1)
    ax.axvline(-0.1, color="#66BB6A", ls="--", lw=0.8, zorder=1)
    ax.axvline(0, color="#333333", ls="-", lw=0.5, zorder=1)

    ax.set_yticks(y_pos)
    ax.set_yticklabels(covariates, fontsize=9)
    ax.set_xlabel("Standardized Mean Difference")
    ax.set_xlim(-0.5, 0.5)
    ax.legend(loc="lower right", fontsize=9)

    fig.tight_layout(pad=0.1)
    fig.savefig(f"{OUTDIR}/figure_b2_2.png", dpi=DPI, bbox_inches="tight",
                facecolor="white")
    plt.close(fig)


# ── Figure B2.3: Forest Plot – Primary & Secondary Estimates ───────

def fig_b2_3():
    fig, (ax_top, ax_bot) = plt.subplots(
        2, 1, figsize=(8, 5), height_ratios=[1, 2.5],
        gridspec_kw={"hspace": 0.45}, layout="constrained",
    )

    # ── Top panel: Primary endpoint (continuous scale) ──
    est_primary, lo_primary, hi_primary = 0.008, -0.006, 0.022
    ni_margin = -0.014

    ax_top.plot([lo_primary, hi_primary], [0, 0], color=COLORS["ket"],
                lw=2.5, solid_capstyle="round")
    ax_top.plot(est_primary, 0, "D", color=COLORS["ket"], markersize=10,
                zorder=5)
    ax_top.axvline(0, color="#333333", ls="-", lw=0.6)
    ax_top.axvline(ni_margin, color="#E53935", ls="--", lw=1,
                   label="NI margin ($-\\Delta$)")
    ax_top.set_yticks([0])
    ax_top.set_yticklabels(["PHQ-9 change/day ($\\beta_3$)"], fontsize=9)
    ax_top.set_xlabel("$\\beta_3$ (PHQ-9 points / day)", fontsize=9)
    ax_top.set_ylim(-0.8, 0.8)
    ax_top.legend(loc="upper right", fontsize=8)
    ax_top.set_title("PRIMARY", fontsize=9, fontweight="bold", loc="left")
    ax_top.text(ni_margin, -0.6, "$-\\Delta$", ha="center", fontsize=8,
                color="#E53935")

    # ── Bottom panel: Secondary endpoints (OR scale) ──
    sec_labels = [
        "Remission (OR)",
        "Response (OR)",
        "SI Remission (OR)",
        "SI During Follow-up (OR)",
    ]
    sec_est = [1.12, 1.08, 1.25, 0.88]
    sec_lo =  [0.85, 0.82, 0.78, 0.62]
    sec_hi =  [1.48, 1.42, 2.00, 1.25]

    y_pos = list(range(len(sec_labels) - 1, -1, -1))
    for i, (est, lo, hi) in enumerate(zip(sec_est, sec_lo, sec_hi)):
        ax_bot.plot([lo, hi], [y_pos[i], y_pos[i]], color=COLORS["esk"],
                    lw=2, solid_capstyle="round")
        ax_bot.plot(est, y_pos[i], "D", color=COLORS["esk"], markersize=8,
                    zorder=5)
        ax_bot.text(hi + 0.04, y_pos[i],
                    f"{est:.2f} ({lo:.2f}\u2013{hi:.2f})",
                    va="center", fontsize=8, color="#555555")

    ax_bot.axvline(1.0, color="#333333", ls="-", lw=0.6)
    ax_bot.set_yticks(y_pos)
    ax_bot.set_yticklabels(sec_labels, fontsize=9)
    ax_bot.set_xlabel("Odds Ratio (95% CI)", fontsize=9)
    ax_bot.set_xlim(0.4, 2.3)
    ax_bot.set_ylim(-0.8, len(sec_labels) - 0.2)
    ax_bot.set_title("SECONDARY", fontsize=9, fontweight="bold", loc="left")

    fig.savefig(f"{OUTDIR}/figure_b2_3.png", dpi=DPI, bbox_inches="tight",
                facecolor="white")
    plt.close(fig)


# ── Figure B2.4: Longitudinal PHQ-9 Trajectories ───────────────────

def fig_b2_4():
    days = np.array([0, 3, 7, 14, 21, 28, 35, 42])
    # Simulated mean trajectories — both decline, ketamine slightly steeper
    ket_mean = 18.0 - 0.28 * days + 0.001 * days**2
    esk_mean = 17.5 - 0.25 * days + 0.001 * days**2
    # CI width grows over time
    ci_width = 0.8 + 0.04 * days

    fig = plt.figure(figsize=(8, 6), layout="constrained")
    gs = fig.add_gridspec(2, 1, height_ratios=[5, 1], hspace=0.05)
    ax = fig.add_subplot(gs[0])
    ax_tbl = fig.add_subplot(gs[1], sharex=ax)

    # Main trajectory plot
    ax.fill_between(days, ket_mean - ci_width, ket_mean + ci_width,
                    alpha=0.15, color=COLORS["ket"])
    ax.fill_between(days, esk_mean - ci_width, esk_mean + ci_width,
                    alpha=0.15, color=COLORS["esk"])
    ax.plot(days, ket_mean, "o-", color=COLORS["ket"], lw=2, markersize=6,
            label="IV Racemic Ketamine")
    ax.plot(days, esk_mean, "s-", color=COLORS["esk"], lw=2, markersize=6,
            label="IN Esketamine")

    ax.set_ylabel("PHQ-9 Total Score (model-derived mean)")
    ax.set_xticks(days)
    ax.set_ylim(0, 24)
    ax.legend(loc="upper right", fontsize=9)
    plt.setp(ax.get_xticklabels(), visible=False)

    # N-at-risk table below the plot
    n_at_risk_ket = ["x,xxx", "x,xxx", "x,xxx", "x,xxx",
                     "x,xxx", "x,xxx", "xxx", "xxx"]
    n_at_risk_esk = ["x,xxx", "x,xxx", "x,xxx", "x,xxx",
                     "x,xxx", "x,xxx", "xxx", "xxx"]

    ax_tbl.set_ylim(0, 3)
    ax_tbl.set_xlim(ax.get_xlim())
    ax_tbl.axis("off")

    row_y = {"label": 2.4, "ket": 1.5, "esk": 0.5}
    ax_tbl.text(-3.5, row_y["label"], "N at risk", ha="right", fontsize=8,
                fontweight="bold", clip_on=False)
    ax_tbl.text(-3.5, row_y["ket"], "KET", ha="right", fontsize=8,
                fontweight="bold", color=COLORS["ket"], clip_on=False)
    ax_tbl.text(-3.5, row_y["esk"], "ESK", ha="right", fontsize=8,
                fontweight="bold", color=COLORS["esk"], clip_on=False)
    for i, d in enumerate(days):
        ax_tbl.text(d, row_y["ket"], n_at_risk_ket[i], ha="center",
                    fontsize=7.5, color=COLORS["ket"])
        ax_tbl.text(d, row_y["esk"], n_at_risk_esk[i], ha="center",
                    fontsize=7.5, color=COLORS["esk"])

    ax_tbl.set_xlabel("Study Day (from index treatment)")

    fig.savefig(f"{OUTDIR}/figure_b2_4.png", dpi=DPI, bbox_inches="tight",
                facecolor="white")
    plt.close(fig)


# ── Figure B2.5: Subgroup Forest Plot ──────────────────────────────

def fig_b2_5():
    subgroups = [
        ("Overall", True),
        ("", False),  # spacer
        ("Oral AD at baseline: Yes", False),
        ("Oral AD at baseline: No", False),
        ("", False),
        ("Severity: Moderate", False),
        ("Severity: Mod. severe", False),
        ("Severity: Severe", False),
        ("", False),
        ("SI at baseline: Q9 \u2265 2", False),
        ("SI at baseline: Q9 < 2", False),
        ("", False),
        ("Age: 18\u201334", False),
        ("Age: 35\u201354", False),
        ("Age: \u226555", False),
        ("", False),
        ("Sex: Female", False),
        ("Sex: Male", False),
        ("", False),
        ("Era: Before Jan 2025", False),
        ("Era: After Jan 2025", False),
        ("", False),
        ("TRD: Yes", False),
        ("TRD: No", False),
    ]

    rng = np.random.default_rng(7)
    estimates, ci_lo, ci_hi = [], [], []
    for label, is_overall in subgroups:
        if label == "":
            estimates.append(None)
            ci_lo.append(None)
            ci_hi.append(None)
        else:
            est = rng.uniform(-0.02, 0.03)
            half = 0.015 if is_overall else rng.uniform(0.025, 0.055)
            estimates.append(est)
            ci_lo.append(est - half)
            ci_hi.append(est + half)

    fig, ax = plt.subplots(figsize=(9, 9))

    y = len(subgroups)
    for i, (sg, _) in enumerate(subgroups):
        y -= 1
        if sg == "" or estimates[i] is None:
            continue
        is_overall = sg == "Overall"
        marker = "D" if is_overall else "o"
        ms = 9 if is_overall else 7
        lw = 2.5 if is_overall else 1.8
        color = COLORS["ket"] if is_overall else "#555555"
        ax.plot([ci_lo[i], ci_hi[i]], [y, y], color=color, lw=lw,
                solid_capstyle="round")
        ax.plot(estimates[i], y, marker, color=color, markersize=ms, zorder=5)
        # n_K / n_E annotation
        ax.text(0.095, y, "(xxx / xxx)", fontsize=7.5, va="center",
                color="#888888")

    ax.axvline(0, color="#333333", ls="-", lw=0.6)
    ni_margin = -0.014
    ax.axvline(ni_margin, color="#E53935", ls="--", lw=1,
               label="NI margin ($-\\Delta$)")

    valid_labels = [s[0] for s in subgroups if s[0] != ""]
    valid_y = []
    y = len(subgroups)
    for sg, _ in subgroups:
        y -= 1
        if sg != "":
            valid_y.append(y)

    ax.set_yticks(valid_y)
    ax.set_yticklabels(valid_labels, fontsize=9)
    ax.set_xlabel(
        "Treatment \u00d7 Time Interaction ($\\beta_3$, PHQ-9 points/day)"
    )
    ax.set_xlim(-0.10, 0.10)
    ax.legend(loc="lower right", fontsize=8)

    # Directional labels
    ax.text(-0.08, -1.5, "\u2190 Favors Esketamine", fontsize=8,
            color="#888888", ha="center")
    ax.text(0.08, -1.5, "Favors Ketamine \u2192", fontsize=8,
            color="#888888", ha="center")

    fig.tight_layout(pad=0.1)
    fig.savefig(f"{OUTDIR}/figure_b2_5.png", dpi=DPI, bbox_inches="tight",
                facecolor="white")
    plt.close(fig)


# ── Main ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Generating figure shells...")
    print("  [1/5] Cohort flow diagram — use mmdc (see figures/figure_b2_1.mmd)")
    fig_b2_2()
    print("  [2/5] Covariate balance (love plot)")
    fig_b2_3()
    print("  [3/5] Primary & secondary forest plot")
    fig_b2_4()
    print("  [4/5] Longitudinal PHQ-9 trajectories")
    fig_b2_5()
    print("  [5/5] Subgroup forest plot")
    print(f"Done. Figures saved to {OUTDIR}/")
