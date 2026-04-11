**TABLE OF CONTENTS** 

**To be added …** 


**STATISTICAL ANALYSIS PLAN – EXECUTIVE SUMMARY**

**Study Title: Real-World Data Analysis of Clinical Outcomes Following Intravenous Racemic Ketamine Versus Intranasal S-Ketamine in Adults with Major Depressive Disorder** 

**Study Rationale**

Intravenous racemic ketamine and intranasal S-ketamine have demonstrated rapid antidepressant and anti-suicidal effects in randomized controlled trials. However, clinical trials are conducted under highly controlled conditions that may limit generalizability to routine clinical practice. This study leverages real-world electronic health record data to compare clinical outcomes associated with these treatments as delivered in usual care settings.

**Study Design**

This is a retrospective observational cohort study conducted using a target trial emulation framework. Adult patients with major depressive disorder initiating intravenous racemic ketamine or intranasal S-ketamine are identified and followed forward in time to assess effectiveness and safety outcomes.

Confounding is addressed using propensity score–based methods, and all analyses are prespecified in this statistical analysis plan.

**Objectives**

*Primary Objective*  
To compare the proportion of patients achieving remission from depression following treatment with intravenous racemic ketamine versus intranasal S-ketamine.

*Secondary Objectives*

* To compare rates of response from depression by treatment group

* To evaluate remission from acute suicidal ideation within 24 hours among patients with baseline suicidal ideation

* To assess presence of suicidal ideation during follow-up

* To evaluate longitudinal changes in severity of depressive symptoms and suicidal ideation

Endpoints

Depression remission and response are defined using validated, instrument-specific thresholds from MADRS, HAM-D, PHQ-9, and QIDS scales. Suicidal ideation outcomes are defined using the Columbia-Suicide Severity Rating Scale (C-SSRS) and single-item measures from individual depression rating scales.

Estimands

The primary estimand is the average treatment effect (ATE) under observed care, representing the difference in outcomes that would be observed if the study population were treated with each intervention according to routine clinical practice. 

Analysis Populations

The Full Analysis Set includes patients with qualifying baseline and post-baseline assessments. The primary causal analyses are conducted in a matched or weighted analysis set derived using propensity score methods. Safety analyses include all treated patients.

Statistical Methods

Binary outcomes are analyzed using generalized linear models. Longitudinal outcomes are analyzed using mixed-effects models accounting for within-patient correlation and irregular follow-up. Missing data are addressed using multiple imputation with sensitivity analyses.

No formal adjustment for multiplicity is applied; emphasis is placed on effect estimates, precision, and consistency across analyses.

Safety Analyses

Safety outcomes include suicidal behaviors and hospitalizations following treatment initiation. These outcomes are summarized descriptively and analyzed using time-to-event methods where appropriate.

Regulatory Alignment

This analysis is conducted in accordance with FDA guidance on real-world evidence and ICH E9(R1) estimand principles. All analyses are prespecified prior to outcome evaluation.

**1\. INTRODUCTION**

**1.1 Background and Rationale**

Major depressive disorder (MDD) is the most common major mental illness worldwide and is associated with significant morbidity and mortality.1 The World Health Organization has listed depression as a leading cause of disability worldwide with an estimated 264 million people suffering from the disorder worldwide.2 As of 2010 the economic burden associated with MDD was estimated to be $210.5 billion in the United States alone.3

A significant proportion of patients diagnosed with MDD do not respond to standard early-line treatments, despite the fact that there are many treatments available (\>20). The diagnosis/categorization of treatment-resistant depression (TRD) is generally given after two antidepressant therapies fail to produce an adequate response for a patient. Most estimates suggest TRD comprises a substantial portion (12-40%) of all patients with depression.5,6

Episodes of TRD are associated with prolonged patient suffering, significant burdens to caregivers and great cost to healthcare systems. Compared to patients with treatment-responsive depression, patients with TRD have been found to have a greater risk of attempting suicide,7 significantly higher rates of hospitalization,8,9 spend longer time periods in depressed states and be more likely to experience job loss8. Additionally, there are dramatic increases in healthcare resource utilization among TRD patients, including higher numbers of emergency department visits, outpatient visits, and prescriptions filled. 10 A recent study of 48,440 individuals with depression found that those with TRD had an average depression duration of 571 days and total medical costs to be 164% higher than non-TRD patients with depression. In sum, TRD yields substantial burden to patients, caregivers, and healthcare systems.

Unfortunately, the therapeutic options for patients suffering with TRD remain limited. Since 2000, an increasing number of small-to-medium sized studies have shown that low doses of ketamine delivered intravenously (IV) can have rapid and robust antidepressant effects in TRD.13-17

In addition to the public health burden of TRD, suicide is also a major public health concern in the United States, where suicide rates have risen substantially despite declines observed globally since 2000 ([Bertuccio, 2025](#heading=h.5xbx6zyzur3y))([Garnett, 2024](#heading=h.hddyx2x7cej7)). People with TRD are at an increased risk of suicide, and TRD and suicidal ideation are often comorbid ([Andersson, 2022](#heading=h.5cwwu528w1wx))([Harris, 1997](#heading=h.5rmcwm72yixi)). 

The spectrum of suicidality encompasses ideation, planning, and attempts, with suicidal ideation serving as a key early indicator for poor subsequent outcomes. Conventional treatments such as cognitive-behavioral therapy and standard pharmacotherapies have demonstrated efficacy in reducing suicidal thoughts; however, their delayed onset of action and variable response rates highlight the demand for rapid-acting therapies particularly suited for acute suicidal crises and severe depressive episodes ([Ballard, 2021](#heading=h.wx9i4hf7yvz8)). In addition to showing robust antidepressant effects, ketamine has also shown rapid and powerful anti-suicidal effects ([Witt, 2020](#heading=h.a2mtjo4gemud)). Meta-analytic evidence reveals that intravenous subanesthetic ketamine induces a substantial anti-suicidal effect within 4 to 6 hours (Cohen’s d \= 1.16, 95% CI: 0.50–1.81), which remains moderately sustained at 24 hours post-treatment (Cohen’s d \= 0.95, 95% CI: 0.48–1.41)([Chen, 2023](#heading=h.5kmbmbx4hio7)).

Despite these developments, several gaps remain in the understanding of ketamine's anti-suicidal effects in real-world settings. While previous studies have demonstrated rapid efficacy of ketamine in reducing suicidal ideation, most of the research has been conducted in highly controlled clinical trials with stringent inclusion criteria, potentially limiting the generalizability of findings to broader psychiatric populations. Furthermore, questions persist regarding the acute onset and durability of ketamine's anti-suicidal effects, the timeline for clinically meaningful improvement, and subsequent risk patterns for suicidal behaviors and hospitalizations following treatment. Therefore, the present analysis aims to investigate suicidality outcomes in adult patients with psychiatric disorders following intravenous administration of subanesthetic dose(s) of racemic ketamine hydrochloride, specifically examining acute changes in suicidal ideation severity, time to clinically meaningful improvement, subsequent suicidal behavior risk, and hospitalization patterns in the post-treatment period.  
Subanesthetic doses of intravenous racemic ketamine and intranasal S-ketamine have demonstrated rapid antidepressant and anti-suicidal effects in randomized controlled trials. However, these trials are conducted under highly controlled conditions, with strict eligibility criteria, protocol-defined dosing schedules, and fixed assessment timepoints. As a result, the generalizability of trial findings to routine clinical practice remains uncertain.

The present study is designed to evaluate the real-world effectiveness of intravenous racemic ketamine compared with intranasal S-ketamine in adult patients with MDD, including patients with acute suicidal ideation, using retrospective electronic health record (EHR) data. This analysis is intended to generate real-world evidence (RWE) suitable for regulatory discussions by applying prespecified, transparent, and reproducible statistical methods aligned with contemporary guidance for observational causal inference.

**1.2 Study Objectives**

**Primary Objective**

The primary objective of this analysis is to compare the **proportion of patients achieving remission from depression** following treatment with intravenous racemic ketamine versus intranasal S-ketamine in real-world clinical practice.

**Secondary Objectives**

The secondary objectives of this analysis are:

1. **To compare the proportion of patients achieving response from depression** by treatment group.

2. **To evaluate the proportion of patients achieving remission from acute suicidal ideation**, defined as a Columbia-Suicide Severity Rating Scale (C-SSRS) Total Ideation Score of 0, 1, or 2 within 24 hours of the first ketamine administration, among patients with baseline C-SSRS ≥ 3\. In addition, changes in severity of suicidal ideation over time will be evaluated using single-item measures derived from the MADRS, QIDS, PHQ-9, and HAM-D.

3. **To evaluate the proportion of patients with any documented suicidal ideation (yes/no)** during the assessment period following acute treatment.

4. **To evaluate changes in depression severity over time**, as measured by change from baseline in:

   * Patient Health Questionnaire-9 (PHQ-9) total score

   * Montgomery–Åsberg Depression Rating Scale (MADRS) total score

   * Quick Inventory of Depressive Symptomatology (QIDS)

   * Hamilton Depression Rating Scale (HAM-D)

**1.3 Study Design**

This study is a **retrospective observational cohort analysis** conducted using a **target trial emulation framework**. Adult patients initiating treatment with intravenous racemic ketamine or intranasal S-ketamine are identified from real-world EHR data and followed forward in time to assess clinical outcomes.

Treatment assignment is not randomized. Confounding is addressed through propensity score–based methods and prespecified covariate adjustment. All analyses are conducted according to this predefined statistical analysis plan to minimize bias and analytic flexibility.

**1.4 Data Sources**

Data are derived from longitudinal electronic health records containing structured clinical information, including diagnoses, treatments, symptom severity assessments, and healthcare utilization. Prior to analysis, data quality assessments are performed to evaluate completeness, plausibility, and temporal alignment of key variables.

ADD MORE ABOUT OSMIND DATA HERE … 

**1.5 Regulatory and Methodological Framework**

This statistical analysis plan is developed in accordance with FDA guidance on the use of real-world evidence for regulatory decision-making and ICH E9(R1) principles on estimands and sensitivity analyses. All analyses specified herein are prespecified prior to outcome evaluation.

**2\. GENERAL ANALYSIS DEFINITIONS**

**2.1 Index Date and Study Periods**

The **index date** is defined as the date of first administration of intravenous racemic ketamine or intranasal S-ketamine.

The **baseline period** is defined as the interval from **14 days prior to the index date through the index date (Day 0\)**.

The **assessment period** begins on the index date and extends through the prespecified follow-up windows defined for each outcome.

**2.2 Baseline Assessment Definition**

Baseline values for depression severity and suicidal ideation are defined as follows:

* Any valid assessment recorded within **14 days prior to the index date**, including the index date, is eligible for use as baseline

* If multiple assessments of the same instrument are available within the baseline window, the assessment **closest in time to the index date** is selected

* Baseline assessments may occur up to 14 days before or on the day of treatment initiation

This approach reflects real-world documentation practices while preserving temporal relevance to treatment initiation.

**2.3 Post-Baseline Assessment Eligibility**

For a patient to be included in analyses involving a specific assessment instrument, the following criteria must be met:

* At least **one baseline assessment** of the instrument within the baseline window

* At least **one post-baseline assessment** of the **same instrument** during the assessment period

Patients without a qualifying post-baseline assessment for a given instrument are excluded from analyses involving that instrument but may contribute to analyses using other instruments for which eligibility criteria are met.

**2.4 Use of Multiple Assessment Instruments**

Depression severity and suicidal ideation are assessed using multiple validated instruments, including:

* **MADRS (Montgomery–Åsberg Depression Rating Scale).** The MADRS is a 10-item clinician-administered scale designed to be sensitive to change in depressive symptom severity, particularly in treatment trials. It has strong interrater reliability and construct validity and is widely used in antidepressant and ketamine/esketamine studies. It includes a validated item assessing suicidal ideation.   
* **HAM-D (Hamilton Depression Rating Scale; HDRS).** The HAM-D is a clinician-rated scale (commonly 17-item version) that assesses core depressive symptoms including mood, guilt, insomnia, and somatic symptoms. It is one of the most extensively validated depression measures, with strong reliability and predictive validity. It includes a validated item assessing suicidal ideation.  
* **PHQ-9 (Patient Health Questionnaire-9).** The PHQ-9 is a 9-item self-report instrument based directly on DSM criteria for major depressive disorder and commonly used in clinical and research settings. It demonstrates excellent internal consistency, criterion validity, and sensitivity/specificity for major depression, and includes a validated item assessing suicidal ideation.  
* **QIDS (Quick Inventory of Depressive Symptomatology-Self Report; QIDS-SR)** The QIDS is available as a self-report (QIDS-SR) format and assesses the nine DSM symptom domains of major depression. It has strong internal consistency, convergent validity with the HAM-D and MADRS, and sensitivity to symptom change across treatment studies, including large effectiveness trials (e.g., STAR\*D). It includes a validated item assessing suicidal ideation.  
* **C-SSRS (Columbia–Suicide Severity Rating Scale).** The C-SSRS is a structured clinician-administered instrument that assesses the severity and intensity of suicidal ideation and behavior. It has demonstrated strong interrater reliability has been widely adopted by the FDA and NIH for use in clinical trials.

Given heterogeneity in assessment practices across clinical settings:

* **Rates of response and remission** are used for primary and secondary binary endpoints

* Instrument-specific thresholds are applied to define response and remission

* Patients may contribute to the analysis using **any single instrument** for which they meet baseline and post-baseline eligibility

This strategy maximizes sample size while maintaining clinical validity.

**2.5 Analysis Sets**

**2.5.1 Source Population**

The source population includes all patients in the EHR database who meet inclusion and exclusion criteria and initiate intravenous racemic ketamine or intranasal S-ketamine during the study period.

**2.5.2 Full Analysis Set (FAS)**

The Full Analysis Set includes all patients who:

* Initiate intravenous racemic ketamine or intranasal S-ketamine

* Have at least one qualifying baseline assessment

* Have at least one qualifying post-baseline assessment of the same instrument

Patients are analyzed according to treatment initiated at the index date.

**2.5.3 Matched / Weighted Analysis Set**

A matched or weighted analysis set is derived from the Full Analysis Set using propensity score methods to balance baseline covariates between treatment groups. This set constitutes the primary population for causal effect estimation. Treatment groups (i.e., ketamine and esketamine) will be balanced on which primary depression rating scale is used to determine remission / response. 

**2.5.4 Safety Analysis Set**

The Safety Analysis Set includes all patients who receive at least one documented administration of intravenous racemic ketamine or intranasal S-ketamine, regardless of assessment availability.

**2.6 Study Day and Relative Day**

Study Day 0 is defined as the index date. Days prior to treatment initiation are assigned negative values, and days following treatment initiation are assigned positive values.

**2.7 Missing Data and Imputation Rules**

Missing data are expected due to non-uniform follow-up and real-world documentation practices.

* The extent and patterns of missing data will be summarized descriptively

* **Multiple imputation** will be used under a missing-at-random (MAR) assumption

**3\. STATISTICAL CONSIDERATIONS**

**3.1 Estimands**

**3.1.1 Primary Estimand**

The primary estimand is the average treatment effect (ATE) under observed care, defined as the difference in remission rates that would be observed if the study population were treated with intravenous racemic ketamine versus intranasal S-ketamine according to routine clinical practice.

**3.1.2 Secondary Estimands**

Secondary estimands include:

* ATE under observed care for response from depression

* ATE under observed care for remission from acute suicidal ideation within 24 hours

* ATE under observed care for presence of any suicidal ideation during follow-up

* ATE under observed care for longitudinal change in depression and suicidal ideation severity

**3.2 Statistical Hypotheses**

**Primary Hypothesis**

* **Null Hypothesis (H₀):**  
  There is no difference in rates of remission from depression between patients treated with intravenous racemic ketamine and those treated with intranasal S-ketamine.

* **Alternative Hypothesis (H₁):**  
  Rates of remission from depression differ between patients treated with intravenous racemic ketamine and those treated with intranasal S-ketamine.

All hypothesis tests are two-sided.

**3.3 Confounding Control**

Confounding will be addressed using propensity score–based methods. Propensity scores estimating the probability of receiving intravenous racemic ketamine versus intranasal S-ketamine will be estimated using prespecified baseline covariates, including sex, age, other demographics, baseline symptom severity, psychiatric comorbidities, prior treatment history, and median income of the zip code where patients live.

Propensity scores will be implemented using matching or weighting approaches. Covariate balance will be assessed using standardized mean differences, with values less than 0.1 indicating acceptable balance.

**3.4 Analysis Methods**

**3.4.1 Binary Outcomes**

Binary outcomes (e.g., remission, response, presence of suicidal ideation) will be analyzed using logistic regression or generalized linear models in the matched or weighted analysis set. Results will be reported as odds ratios or risk differences with two-sided 95% confidence intervals.

**3.4.2 Longitudinal Continuous Outcomes**

Changes in depression and suicidal ideation severity over time will be analyzed using mixed-effects models for repeated measures or generalized linear mixed models, accounting for within-patient correlation and irregular follow-up.

**3.5 Multiplicity**

No formal adjustment for multiplicity will be applied. The primary endpoint will be interpreted as the principal analysis. Secondary endpoints are prespecified and will be interpreted with consideration of effect size, precision, and consistency across analyses rather than statistical significance alone.

**3.6 Sensitivity Analyses**

Prespecified sensitivity analyses will evaluate robustness to:

* Alternative propensity score specifications

* Alternative matching or weighting strategies

* Complete-case versus multiply imputed analyses

* Alternative outcome definitions

**4\. SUBJECT DISPOSITION AND BASELINE CHARACTERISTICS**

**4.1 Subject Disposition**

Subject disposition will be summarized using a cohort flow diagram analogous to a CONSORT diagram, adapted for real-world data.

The following counts will be reported:

* Number of patients in the source population meeting general inclusion and exclusion criteria

* Number of patients initiating intravenous racemic ketamine

* Number of patients initiating intranasal S-ketamine

* Number of patients with at least one qualifying baseline assessment

* Number of patients with at least one qualifying post-baseline assessment of the same instrument

* Number of patients included in the Full Analysis Set

* Number of patients included in the matched or weighted analysis set

* Number of patients included in the Safety Analysis Set

Reasons for exclusion from analysis sets will be summarized descriptively and may include:

* Absence of qualifying baseline assessment

* Absence of qualifying post-baseline assessment

* Missing key covariates required for propensity score estimation

No patients will be excluded based on post-baseline outcomes.

**4.2 Follow-up and Assessment Availability**

Follow-up time will be summarized separately for each treatment group.

The following will be reported:

* Distribution of time from index date to last available assessment

* Number and proportion of patients with at least one post-baseline assessment within prespecified follow-up windows

* Distribution of number of assessments per patient by instrument (MADRS, HAM-D, PHQ-9, QIDS, C-SSRS)

Assessment availability will be summarized to characterize heterogeneity in real-world documentation practices and to contextualize missing data patterns.

**4.3 Demographics and Baseline Clinical Characteristics**

Baseline demographic and clinical characteristics will be summarized for:

* The Full Analysis Set

* The matched or weighted analysis set

Characteristics will include:

**Demographics**

* Age at index date

* Sex

* Race and ethnicity 

* Median income of zip code (a measure of socioeconomic status) 

**Clinical Characteristics**

* Baseline depression severity (instrument-specific)

* Baseline suicidal ideation severity (C-SSRS category)

* Comorbid psychiatric diagnoses

* Comorbid medical diagnoses

* History of substance use disorder

* Prior psychiatric hospitalizations

* Prior suicide attempts

**Treatment History**

* Prior antidepressant exposure

* Prior ketamine or esketamine exposure (outside exclusion windows, if applicable)

* Concomitant psychotropic medications at baseline

Continuous variables will be summarized using means and standard deviations or medians and interquartile ranges, as appropriate. Categorical variables will be summarized using counts and percentages.

**4.4 Baseline Comparability and Covariate Balance**

Baseline comparability between treatment groups will be assessed descriptively in the Full Analysis Set and quantitatively in the matched or weighted analysis set.

Covariate balance will be evaluated using standardized mean differences (SMDs):

* SMDs will be reported for all covariates included in the propensity score model

* An SMD less than 0.1 will be considered indicative of acceptable balance

Balance diagnostics will be presented in tabular and graphical form, as appropriate.

**4.5 Treatment Exposure and Persistence**

Treatment exposure will be summarized descriptively by treatment group, including:

* Number of administrations

* Time between administrations

* Duration of observed treatment exposure

Given the observational nature of the data, treatment exposure summaries are intended to describe real-world treatment patterns rather than enforce protocol adherence.

**4.6 Attrition and Missingness**

Attrition and missingness will be summarized to characterize potential sources of bias.

The following will be reported:

* Proportion of patients with incomplete follow-up

* Proportion of missing outcome assessments by timepoint and instrument

* Patterns of missingness relative to baseline characteristics and treatment group

These summaries will inform interpretation of primary and secondary analyses and guide sensitivity analyses.

**4.7 Deviations from Pre-specified Analysis Plans** 

Departures from prespecified analysis definitions (if any) will be documented and justified in the final study report.

**5\. EFFECTIVENESS ANALYSES**

**5.1 General Analysis Specifications**

**5.1.1 Analysis Population**

All effectiveness analyses will be conducted in the **matched or weighted analysis set**, unless otherwise specified. Patients will be analyzed according to the treatment initiated at the index date.

Analyses will be conducted separately by outcome and assessment instrument, based on instrument-specific eligibility as defined in Section 2\.

**5.1.2 Level of Significance**

All hypothesis tests will be two-sided. A nominal significance level of 0.05 will be used for the primary endpoint. Secondary endpoints will be interpreted descriptively, with emphasis on effect sizes and confidence intervals.

**5.1.3 Data Handling Rules**

* Baseline values will be defined according to Section 2.2

* Post-baseline assessments will be assigned based on observed assessment dates

* No interpolation of outcome values will be performed

* When multiple post-baseline assessments occur within a given analysis window, the assessment closest to the target timepoint will be used

**5.2 Primary Effectiveness Endpoint**

**5.2.1 Definition**

The primary effectiveness endpoint is **remission from depression**, defined using instrument-specific thresholds:

* **MADRS:** total score ≤ 10

* **HAM-D:** total score ≤ 7

* **PHQ-9:** total score ≤ 4

* **QIDS:** total score ≤ 5

A patient is considered to have achieved remission if remission is observed at any qualifying post-baseline assessment during the assessment period.

**5.2.2 Estimand**

The primary estimand is the **average treatment effect (ATE) under observed care** comparing intravenous racemic ketamine versus intranasal S-ketamine on remission from depression.

**5.2.3 Analysis Methods**

The primary analysis will compare remission rates between treatment groups using a generalized linear model with a logit link.

* Treatment group will be included as the primary independent variable

* Analyses will be conducted in the matched or weighted analysis set

* Robust standard errors will be used where appropriate

Results will be reported as odds ratios and/or risk differences with two-sided 95% confidence intervals.

**5.3 Secondary Effectiveness Endpoints**

**5.3.1 Response from Depression**

**Definition**

Response from depression is defined using instrument-specific thresholds:

* **MADRS / HAM-D / PHQ-9 / QIDS:** ≥ 50% reduction from baseline

**Analysis Methods**

Response rates will be analyzed using logistic regression models analogous to the primary analysis. Results will be summarized using effect estimates and confidence intervals.

**5.3.2 Remission from Acute Suicidal Ideation**

**Definition**

Remission from acute suicidal ideation is defined as a **C-SSRS Total Ideation Score of 0, 1, or 2** within the assessment period, among patients with baseline C-SSRS ≥ 3\.

**Analysis Methods**

The proportion of patients achieving remission from acute suicidal ideation will be compared between treatment groups using logistic regression models. Analyses will be restricted to patients meeting baseline eligibility criteria of C-SSRS ≥ 3\.

**5.3.3 Change in Suicidal Ideation Severity Over Time**

**Definition**

Change in suicidal ideation severity will be evaluated using single-item measures derived from:

* MADRS

* QIDS

* PHQ-9

* HAM-D

Change in suicidal ideation severity will also be evaluated using the ideation subscale of the C-SSRS (score 0-5). 

**Analysis Methods**

Longitudinal changes in suicidal ideation severity will be analyzed using mixed-effects models, incorporating:

* Fixed effects for treatment group and time

* Random effects for patient

* Appropriate covariance structures to account for within-patient correlation

**5.3.4 Presence of Any Suicidal Ideation During Follow-up**

**Definition**

Presence of suicidal ideation is defined as **any documented suicidal ideation (yes/no)** during the assessment period following acute treatment.

**Analysis Methods**

The proportion of patients with any documented suicidal ideation will be compared between treatment groups using logistic regression models.

**5.3.5 Change in Depression Severity Over Time**

**Definition**

Change from baseline in depression severity will be evaluated using:

* PHQ-9 total score

* MADRS total score

* QIDS total score

* HAM-D total score

**Analysis Methods**

Longitudinal changes in depression severity will be analyzed using mixed-effects models for repeated measures or generalized linear mixed models, as appropriate.

Models will include treatment group, time, and their interaction as fixed effects.

**5.4 Subgroup Analyses**

Exploratory subgroup analyses may be conducted by:

* Baseline depression severity

* Presence of baseline suicidal ideation

* Age group

* Sex

Subgroup analyses will be interpreted descriptively.

**5.5 Sensitivity Analyses**

Sensitivity analyses will include:

* Alternative propensity score specifications

* Alternative matching or weighting approaches

* Complete-case analyses compared with multiply imputed results

Results will be evaluated for consistency with the primary analysis.

**5.6 Presentation of Results**

Results will be summarized using:

* Tables of response and remission rates by treatment group

* Forest plots of effect estimates and confidence intervals

* Longitudinal plots of symptom severity over time

No interim analyses are planned.

**6\. SAFETY AND HEALTHCARE UTILIZATION**

**6.1 Safety Analysis Population**

All safety analyses will be conducted in the **Safety Analysis Set**, defined as all patients who received at least one documented administration of intravenous racemic ketamine or intranasal S-ketamine.

Patients will be analyzed according to the treatment initiated at the index date.

**6.2 Suicidal Behaviors**

**6.2.1 Definitions**

Suicidal behaviors include:

* Suicide attempts

* Completed suicide

Events will be identified using structured EHR fields, diagnostic codes, and clinical documentation where available.

**6.2.2 Analysis Methods**

The incidence of suicidal behaviors during the assessment period will be summarized descriptively by treatment group.

Where event counts permit, comparative analyses may be conducted using:

* Kaplan–Meier methods for time to first event

* Cox proportional hazards models

Results will be interpreted descriptively due to expected low event frequency.

**6.3 Hospitalizations**

**6.3.1 Definition**

Hospitalization is defined as any inpatient admission documented during the assessment period following treatment initiation.

Hospitalizations may include:

* Psychiatric hospitalizations

* Medical hospitalizations

* Hospitalizations related to suicidal ideation or behavior

**6.3.2 Analysis Methods**

Hospitalization outcomes will be evaluated using:

* Proportion of patients with ≥1 hospitalization

* Time to first hospitalization

Comparative analyses between treatment groups will be conducted using logistic regression or time-to-event models, as appropriate.

**6.4 Other Safety Signals**

Given limitations of EHR data for comprehensive adverse event capture:

* No formal adverse event incidence tables are planned

* Safety analyses focus on **clinically meaningful outcomes** (hospitalization, suicidal behavior)

Findings will be contextualized accordingly.

**APPENDIX A: OUTCOME DEFINITIONS**

**A1. Depression Severity Outcomes**

| Instrument | Remission Definition | Response Definition |
| :---- | :---- | :---- |
| MADRS | ≤10 | ≥50% reduction |
| HAM-D | ≤7 | ≥50% reduction |
| PHQ-9 | ≤4 | ≥50% reduction |
| QIDS | ≤5 | ≥50% reduction |

**A2. Suicidal Ideation Outcomes**

* **Acute SI Remission:**  
  C-SSRS Total Ideation Score \= 0, 1, or 2

* **Baseline SI Eligibility:**  
  C-SSRS ≥ 3

* **Presence of SI During Follow-up:**  
  Any documentation of suicidal ideation (yes/no)

**APPENDIX B: PROPENSITY SCORE DIAGNOSTICS**

**B1. Covariates Included**

Covariates included in propensity score estimation may include:

* Age

* Sex

* Baseline depression severity

* Baseline suicidal ideation severity

* Comorbid psychiatric diagnoses

* Comorbid medical diagnoses 

* History of substance use disorder

* Prior psychiatric hospitalization

* Concomitant psychotropic medications

**B2. Balance Assessment**

* Standardized mean differences (SMDs) will be reported for all covariates

* SMD \< 0.1 will be considered acceptable balance

* Balance will be assessed pre- and post-matching/weighting

Graphical diagnostics (e.g., Love plots) may be provided.

**APPENDIX C: TABLE AND FIGURE SHELLS**

**C1. Tables**

**Table 1\.** Subject Disposition and Analysis Sets  
**Table 2\.** Baseline Demographics and Clinical Characteristics  
**Table 3\.** Covariate Balance Before and After Propensity Score Adjustment  
**Table 4\.** Depression Remission Rates by Treatment Group  
**Table 5\.** Depression Response Rates by Treatment Group  
**Table 6\.** Remission from Acute Suicidal Ideation  
**Table 7\.** Presence of Suicidal Ideation During Follow-up  
**Table 8\.** Hospitalization Outcomes

**C2. Figures**

**Figure 1\.** Cohort Flow Diagram  
**Figure 2\.** Covariate Balance (Standardized Mean Differences)  
**Figure 3\.** Forest Plot of Primary and Secondary Effect Estimates  
**Figure 4\.** Longitudinal Change in Depression Severity  
**Figure 5\.** Kaplan–Meier Curve for Time to Hospitalization

**C3. Listings (if applicable)**

* Individual-level outcome listings (de-identified)

* Assessment timing summaries

