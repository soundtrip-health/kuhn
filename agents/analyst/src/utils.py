"""Utility functions for ASCP 2026 analysis."""

from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import requests

FONTCOLOR = 'rgba(0.1,0.1,0.1,1.0)'
FONTSIZE = 16
FIGDIR = Path("./draft/figures")
FIGDIR.mkdir(exist_ok=True, parents=True)
TABDIR = Path("./draft/tables")
TABDIR.mkdir(exist_ok=True, parents=True)

SSRI = ["citalopram", "escitalopram", "fluoxetine", "fluvoxamine",
        "paroxetine", "sertraline", "indalpine", "zimelidine"]
SNRI = ["desvenlafaxine", "duloxetine", "levomilnacipran", "milnacipran", "venlafaxine"]
SDRI = ["medifoxamine"]
SNDRI = ["dextromethorphan", "bupropion", "toludesvenlafaxine", "nefazodone"]
SMS = ["vortioxetine", "vilazodone"]
SARI = ["nefazodone", "trazodone", "etoperidone"]
ETC = ["mirtazapine", "amitriptyline", "nortriptyline", "isocarboxazid", "phenelzine", "selegiline", 
       "tranylcypromine", "amoxapine", "clomipramine", "desipramine", "doxepin", "imipramine", 
       "protriptyline", "trimipramine", "maprotiline"]
AUG = ["brexpiprazole"]
ANTIDEPRESSANTS = SSRI + SNRI + SDRI + SNDRI + SMS + SARI + ETC + AUG

def CMAP(idx, alpha=0.8):
    colors = ["0.07,0.65,0.47", "0.22,0.41,0.67", "0.95,0.72,0.0", "0.50,0.24,0.55"]
    return f"rgba({colors[idx]},{alpha})"


def style_fig(fig, width=None, height=None, xrange=None, yrange=None, fname=None, grid=True):
    xax = dict(zerolinecolor="rgba(0.7,0.7,0.75,0.3)", gridcolor="rgba(0.7,0.7,0.75,0.2)")
    if xrange:
        xax["range"] = xrange
    yax = dict(zerolinecolor="rgba(0.7,0.7,0.75,0.3)", gridcolor="rgba(0.7,0.7,0.75,0.2)")
    if yrange:
        yax["range"] = yrange
    fig.update_layout(
        width=width,
        height=height,
        font=dict(size=FONTSIZE, color=FONTCOLOR),
        paper_bgcolor='rgba(0,0,0,0)',
        plot_bgcolor='rgba(0,0,0,0)',
        xaxis=xax,
        yaxis=yax,
        margin=dict(l=10, r=2, t=20, b=5),
    )
    if fname:
        fig.write_image(FIGDIR / fname, scale=3)
    return fig


def plot_timeseries(df, sem=False, ytitle="PHQ-9 Score", units="days", group_col="treatment", time_bin=5):
    min_time = df['time'].min() // time_bin * time_bin - time_bin
    bin_edges = np.arange(min_time, df['time'].max() + time_bin, time_bin)
    bin_labels = bin_edges[:-1] + time_bin
    tmpdf = df.copy()
    tmpdf["time_bin"] = pd.cut(df["time"], bins=bin_edges, labels=bin_labels, include_lowest=True).astype(float)
    aggdf = tmpdf.groupby([group_col, "time_bin"])["outcome"].agg(["mean", "std", "count"]).reset_index()
    if sem:
        aggdf["ci"] = aggdf["std"] / np.sqrt(aggdf["count"] - 1) * 1.96

    fig = go.Figure()
    for cnt, group in enumerate(aggdf[group_col].unique()):
        group_df = aggdf[aggdf[group_col] == group]

        # Add error band (shaded area)
        tmpdf = group_df.dropna()
        x = tmpdf['time_bin'].tolist() + tmpdf['time_bin'].tolist()[::-1]
        y = (tmpdf['mean'] + tmpdf['std']).tolist() + (tmpdf['mean'] - tmpdf['std']).tolist()[::-1]
        fig.add_trace(go.Scatter(
            x=x,
            y=y,
            fill='toself',
            fillcolor=CMAP(cnt, 0.05),
            line=dict(color='rgba(255,255,255,0)'),
            name=f'{group} stdev',
            showlegend=False,
            hoverinfo='skip'
        ))

        if sem:
            y = (tmpdf['mean'] + tmpdf['ci']).tolist() + (tmpdf['mean'] - tmpdf['ci']).tolist()[::-1]
            fig.add_trace(go.Scatter(
                x=x,
                y=y,
                fill='toself',
                fillcolor=CMAP(cnt, 0.15),
                line=dict(color='rgba(255,255,255,0)'),
                name=f'{group} stdev',
                showlegend=False,
                hoverinfo='skip'
            ))

        # Add main line
        fig.add_trace(go.Scatter(
            x=group_df['time_bin'],
            y=group_df['mean'],
            name=group,
            mode='lines',
            line=dict(width=3, color=CMAP(cnt)),
            marker=dict(size=8)
        ))

    fig.update_layout(
        xaxis=dict(title=f"Time ({units})", dtick=15),
        yaxis=dict(title=ytitle, dtick=5),
        hovermode='x unified',
        showlegend=True,
        legend=dict(yanchor="top", y=0.99, xanchor="right", x=0.99)
    )
    return fig


def stratified_subsample(df, bin_size=3):
    """Original one-variable matching for side-by-side comparison with CEM.

    Subsample Ketamine patients to match the Esketamine baseline outcome
    distribution using a single binned baseline variable.
    """
    baseline_scores = df[df['time'] < 0].groupby(['id', 'treatment'])['outcome'].mean().reset_index()

    bins = np.arange(0, 31, bin_size)
    baseline_scores['bin'] = pd.cut(baseline_scores['outcome'], bins=bins)

    eske_pool = baseline_scores[baseline_scores['treatment'] == 'Esketamine']
    ket_pool = baseline_scores[baseline_scores['treatment'] == 'Ketamine']

    target_distribution = eske_pool['bin'].value_counts()

    matched_ketamine_ids = []
    for bin_val, count in target_distribution.items():
        available_ketamine = ket_pool[ket_pool['bin'] == bin_val]
        if len(available_ketamine) >= count:
            sampled = available_ketamine.sample(n=count, random_state=42)
        else:
            sampled = available_ketamine
        matched_ketamine_ids.extend(sampled['id'].tolist())

    final_ids = eske_pool['id'].tolist() + matched_ketamine_ids
    return df[df['id'].isin(final_ids)].copy()


def generate_nlme_latex(df, show_stars=False, label="tab:model_results"):
    """Convert nlme tTable CSV to a professional LaTeX table.

    Args:
        df: Dataframe generated by R's write.csv(summary(model)$tTable).
        show_stars: Whether to include significance stars (*, **, ***).
        label: The LaTeX label for cross-referencing.
    """
    col_mapping = {
        'Value': 'Estimate',
        'Std.Error': 'Std. Error',
        'DF': '$df$',
        't-value': '$t$-stat',
        'p-value': '$p$-value'
    }
    df = df.rename(columns=col_mapping)

    original_p = df['$p$-value'].copy()

    def p_formatter(p):
        if p < 0.001:
            formatted = "{:.2e}".format(p)
            base, exponent = formatted.split('e')
            return f"${base} \\times 10^{{{int(exponent)}}}$"
        else:
            return f"{p:.3f}"

    df['$p$-value'] = original_p.apply(p_formatter)

    if show_stars:
        def get_stars(p):
            if p < 0.001: return '$^{***}$'
            if p < 0.01:  return '$^{**}$'
            if p < 0.05:  return '$^{*}$'
            return ''
        df['$p$-value'] = df['$p$-value'] + original_p.apply(get_stars)

    numeric_cols = ['Estimate', 'Std. Error', '$t$-stat']
    for col in numeric_cols:
        if col in df.columns:
            df[col] = df[col].apply(lambda x: f"{x:.3f}")

    df.index = [str(i).replace('.', ' ').replace('(Intercept)', '(Baseline)') for i in df.index]

    latex_str = df.to_latex(
        index=True,
        caption="Non-linear Mixed-Effects Model Estimates",
        label=label,
        column_format='l' + 'r' * len(df.columns),
        escape=False
    )

    return latex_str


def generate_consort_figures(
    consort_df,
    figdir,
    start_date="3/1/2021",
    end_date="3/1/2026",
    min_age=18,
    max_age=None,
    merge_outcome_steps=False,
):
    """Render participant consort diagram Mermaid diagrams as PNG files."""
    import shutil
    import subprocess
    import tempfile

    mmdc_path = shutil.which("mmdc")
    if mmdc_path is None:
        print(
            "Mermaid CLI (mmdc) was not found on PATH. "
            "Install it with `npm install -g @mermaid-js/mermaid-cli` "
            "and re-run figure generation."
        )
        return

    age_criterion = f"age >= {min_age}"
    if max_age is not None:
        age_criterion = f"age >= {min_age} and <= {max_age}"

    for _, row in consort_df.iterrows():
        treatment = row["treatment"]
        ntot = row["ntot"]
        nage = row["nage"]
        nmdd = row["nmdd"]
        noutcome_baseline = row["noutcome_baseline"]
        noutcome_followup = row["noutcome_followup"]

        if merge_outcome_steps:
            outcome_nodes = f"""
    CheckOutcomeCombined["Baseline and post-trreatment outcome"]
    ExcludeOutcomeCombined["N = {nmdd - noutcome_followup}"]
    Pop3(["N = {noutcome_followup} ({100 * noutcome_followup / ntot:.1f}%)"])
"""
            outcome_connections = """
    Pop2 --> CheckOutcomeCombined
    CheckOutcomeCombined -->|No| ExcludeOutcomeCombined
    CheckOutcomeCombined --> Pop3
"""
            outcome_styles = "ExcludeOutcomeCombined"
        else:
            outcome_nodes = f"""
    CheckOutcomeBaseline["Baseline outcome"]
    ExcludeOutcomeBaseline["N = {nmdd - noutcome_baseline}"]
    Pop3(["N = {noutcome_baseline} ({100 * noutcome_baseline / ntot:.1f}%)"])
    CheckOutcomeFollowup["Followup outcome"]
    ExcludeOutcomeFollowup["N = {noutcome_baseline - noutcome_followup}"]
    Pop4(["N = {noutcome_followup} ({100 * noutcome_followup / ntot:.1f}%)"])
"""
            outcome_connections = """
    Pop2 --> CheckOutcomeBaseline
    CheckOutcomeBaseline -->|No| ExcludeOutcomeBaseline
    CheckOutcomeBaseline --> Pop3
    Pop3 --> CheckOutcomeFollowup
    CheckOutcomeFollowup -->|No| ExcludeOutcomeFollowup
    CheckOutcomeFollowup --> Pop4
"""
            outcome_styles = "ExcludeOutcomeBaseline,ExcludeOutcomeFollowup"

        mermaid_code = f"""
%% {treatment} participant consort diagram
flowchart TD
    %% Nodes
    Start(["{treatment}<br/>({start_date} - {end_date})<br/>N = {ntot}"])
    CheckAge["{age_criterion}"]
    ExcludeAge["N = {ntot - nage}"]
    Pop1(["N = {nage} ({100 * nage / ntot:.1f}%)"])
    CheckMDD["MDD diagnosis"]
    ExcludeMDD["N = {nage - nmdd}"]
    Pop2(["N = {nmdd} ({100 * nmdd / ntot:.1f}%)"])
{outcome_nodes}

    %% Connections
    Start --> CheckAge
    CheckAge -->|No| ExcludeAge
    CheckAge --> Pop1
    Pop1 --> CheckMDD
    CheckMDD -->|No| ExcludeMDD
    CheckMDD --> Pop2
{outcome_connections}

    %% Styling for the "No" boxes
    classDef grayBackground fill:#d3d3d3,stroke:#333,stroke-width:2px;
    class ExcludeAge,ExcludeMDD,{outcome_styles} grayBackground;
"""
        output_path = figdir / f"consort_{treatment.lower()}.png"
        with tempfile.NamedTemporaryFile(mode="w", suffix=".mmd", delete=False) as tmp:
            tmp.write(mermaid_code)
            tmp_path = tmp.name
        try:
            subprocess.run(
                [mmdc_path, "-i", tmp_path, "-o", str(output_path), "--backgroundColor", "transparent"],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr.strip() if exc.stderr else "No error output from mmdc."
            raise RuntimeError(f"Failed to render consort diagram for {treatment}: {stderr}") from exc
        finally:
            Path(tmp_path).unlink(missing_ok=True)


def clean_demographics(demodf):
    """Normalize demographic fields for downstream summary tables/plots."""
    gender_map = {
        'F': 'Female',
        'M': 'Male',
        'X': 'Non-binary/Other',
        'Unknown': 'Unknown/Declined',
    }

    ethnicity_map = {
        'Hispanic or Latino': 'Hispanic/Latino',
        'Non Hispanic or Latino': 'Non-Hispanic',
        'Unknown': 'Unknown/Declined',
    }

    def clean_race(val):
        if val is None:
            return 'Unknown/Declined'
        if ',' in val:
            return 'Two or More Races'
        if 'Unknown' in val or 'Decline' in val:
            return 'Unknown/Declined'
        if 'Black' in val or 'African' in val:
            return 'Black or African American'
        if 'White' in val:
            return 'White'
        if 'Asian' in val:
            return 'Asian'
        if 'American Indian' in val:
            return 'American Indian/Alaska Native'
        if 'Native Hawaiian' in val:
            return 'Native Hawaiian/Pacific Islander'
        return 'Other'

    cleaned = demodf.copy()
    cleaned['gender'] = cleaned['gender'].fillna('Unknown').map(gender_map)
    cleaned['ethnicity'] = cleaned['ethnicity'].fillna('Unknown').map(ethnicity_map)
    cleaned['race'] = cleaned['race'].fillna('Unknown').apply(clean_race)
    return cleaned


def get_median_income(zip_code, api_key):
    """
    Retrieves median household income for a ZIP code (ZCTA) using 2023 ACS 5-Year data.

    You can request an API key at https://api.census.gov/data/key_signup.html

    Args:
        zip_code: The ZIP code to retrieve income data for.
        api_key: The API key to use to access the Census API.
    
    Returns:
        The median household income for the ZIP code.
    """
    # Base URL for 2023 American Community Survey 5-Year Data
    url = "https://api.census.gov/data/2023/acs/acs5"
    
    params = {
        "get": "NAME,B19013_001E",
        "for": f"zip code tabulation area:{zip_code}",
        "key": api_key
    }
    
    try:
        response = requests.get(url, params=params, timeout=60)
        response.raise_for_status()
        data = response.json()
        income = int(data[1][1])
        # ACS sentinel values are negative; treat them as missing.
        return income if income > 0 else None
    except Exception as e:
        print(f"Error: {e}")
        return None


def fetch_all_zip_median_income(api_key=None, year=2023):
    """Fetch median household income for all ZCTAs from ACS 5-year estimates.

    Args:
        api_key: Optional Census API key.
        year: ACS release year (e.g., 2023 for 2019-2023 5-year estimates).

    Returns:
        DataFrame with columns:
        - zip_code (5-digit ZCTA)
        - zcta_name
        - median_income (nullable Int64)
        - census_year
    """
    url = f"https://api.census.gov/data/{year}/acs/acs5"
    params = {
        "get": "NAME,B19013_001E",
        "for": "zip code tabulation area:*",
    }
    if api_key:
        params["key"] = api_key

    response = requests.get(url, params=params, timeout=180)
    response.raise_for_status()
    raw = response.json()
    header = raw[0]
    rows = raw[1:]
    idx_name = header.index("NAME")
    idx_income = header.index("B19013_001E")
    idx_zip = header.index("zip code tabulation area")

    records = []
    for row in rows:
        income = int(row[idx_income])
        records.append(
            {
                "zip_code": str(row[idx_zip]).zfill(5),
                "zcta_name": row[idx_name],
                "median_income": income if income > 0 else None,
                "census_year": int(year),
            }
        )

    df = pd.DataFrame.from_records(records)
    df["median_income"] = df["median_income"].astype("Int64")
    return df.sort_values("zip_code").reset_index(drop=True)

def is_antidepressant(drug_name):
    """Return True if the drug is an antidepressant."""
    return drug_name.lower() in ANTIDEPRESSANTS
