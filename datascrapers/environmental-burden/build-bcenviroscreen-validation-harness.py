#!/usr/bin/env python3

import csv
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
VENDOR_ROOT = SCRIPT_DIR.parents[2]
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-validation"
SHINY_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "official-shiny-table" / "lha-indicators.csv"
SPATIAL_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-spatial-lha" / "lha-spatial-indicators.json"
CENSUS_BASE = SCRIPT_DIR.parent / "census" / "output" / "bcenviroscreen-census-lha"
CANUE_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-canue-lha" / "lha-canue-candidates.json"
CANUE_POSTAL_BASE = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "compact" / "canue-postal-aggregates" / "bcHealth" / "lha"
EMS_CANDIDATES_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-ems-lha" / "lha-water-quality-exceedance-candidates.csv"
HEALTH_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-health-lha" / "lha-health-candidates.json"
EI_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-ei-lha" / "lha-employment-insurance-candidates.json"
DISTURBED_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-disturbed-lha" / "lha-disturbed-candidates.json"
IFL_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-ifl-lha" / "lha-ifl-candidates.json"
TRAFFIC_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-traffic-lha" / "lha-traffic-candidates.json"
NRCAN_INDUSTRIAL_PATH = (
    SCRIPT_DIR
    / "output"
    / "bc-enviro-screen"
    / "rebuilt-nrcan-industrial-lha"
    / "lha-nrcan-industrial-candidates.json"
)
DRA_GDB_PATH = (
    SCRIPT_DIR
    / "output"
    / "bc-enviro-screen"
    / "raw-rebuild-seed"
    / "large"
    / "digital-road-atlas"
    / "dgtl_road_atlas.gdb.zip"
)
DRA_PARQUET_MPAR_PATH = (
    SCRIPT_DIR
    / "output"
    / "bc-enviro-screen"
    / "raw-rebuild-seed"
    / "large"
    / "digital-road-atlas"
    / "parquet"
    / "dgtl_road_atlas_mpar.parquet"
)


# Some health candidates have similar values but different populations or
# measures. Prefer the field that matches the paper's indicator definition
# before using benchmark fit as a tie-breaker. In particular, the unqualified
# PHSA hypertension field is the total-population incidence rate; fields with a
# male/female suffix and lifetime-prevalence fields are not equivalent.
PREFERRED_CANDIDATE_FIELDS = {
    "hypertension": {
        "phsa_general_health_hypertension_age_standardized_incidence_rate_per_1000_population_20plus_yrs_fy_2015_2016_per_1000_population",
    },
}


INDICATOR_CANDIDATES = {
    "wildfire_burn_area": [
        ("spatial", "wildfire_2010_2019_area_percent", "confirmed paper window: burn area percent, 2010-2019"),
        ("spatial", "wildfire_2011_2020_area_percent", "sensitivity window"),
        ("spatial", "wildfire_2008_2017_area_percent", "sensitivity window"),
        ("spatial", "wildfire_2015_2024_area_percent", "modern sensitivity window"),
        ("spatial", "wildfire_all_years_area_percent", "all historical fire perimeters"),
    ],
    "remediation_sites": [
        ("spatial", "remediation_sites_site_id_lte_23504_count", "BC Environmental Remediation Sites point count with SITE_ID <= 23504, empirical paper-era/source-vintage proxy"),
        ("spatial", "remediation_sites_count", "current BC Environmental Remediation Sites point count"),
    ],
    "industrial_sites": [
        (
            "nrcan_industrial",
            "nrcan_current_mills_mines_smelters_oil_gas_count",
            "Current official NRCan source-family proxy: forestry mills + producing metal, nonmetal and coal mines + smelters/refineries + oil/gas fields assigned to LHA",
        ),
        ("spatial", "industrial_sites_timber_operating_mines_oil_unique_count", "timber facilities + operating major mine representative points + unique oil field names assigned by representative point"),
        ("spatial", "industrial_sites_timber_operating_mines_representative_count", "timber facilities + operating major mine representative points"),
        ("spatial", "industrial_sites_timber_operating_mines_gas_unique_count", "timber facilities + operating major mine representative points + unique gas field names assigned by representative point"),
        ("spatial", "industrial_sites_timber_operating_mines_oil_gas_unique_count", "timber facilities + operating major mine representative points + unique oil/gas field names assigned by representative point"),
        ("spatial", "industrial_sites_operating_2022_proxy_count", "timber + operating major mines issued through 2022 + oil/gas fields"),
        ("spatial", "industrial_sites_2022_proxy_count", "timber + major mines issued through 2022 + oil/gas fields"),
        ("spatial", "industrial_sites_operating_proxy_count", "timber + operating major mines + oil/gas fields"),
        ("spatial", "industrial_sites_proxy_count", "timber + all major mines + oil/gas fields"),
    ],
    "linear_footprint": [
        ("spatial", "paper_dedup_linear_footprint_km_per_sq_km", "Paper-source candidate with DRA roads and forest-tenure roads excluded when within 1 km of DRA roads"),
        ("spatial", "paper_available_plus_dra_linear_footprint_km_per_sq_km", "Available paper-source candidate plus Digital Road Atlas MPAR roads, no forest-road de-duplication"),
        ("spatial", "paper_available_linear_footprint_km_per_sq_km", "Available paper-source candidate: BCER lines + forest-tenure roads + railway + transmission, excluding DRA and Trans Mountain"),
        ("spatial", "forest_tenure_road_sections_not_within_1km_dra_km_per_sq_km", "Forest-tenure road sections retained after excluding sections within 1 km of DRA roads"),
        ("spatial", "bcgw_forest_tenure_road_sections_km_per_sq_km", "BC Geographic Warehouse forest-tenure road sections only"),
        ("spatial", "bcgw_railway_track_km_per_sq_km", "BC Geographic Warehouse railway track only"),
        ("spatial", "bcgw_transmission_lines_km_per_sq_km", "BC Geographic Warehouse BC transmission lines only"),
        ("spatial", "bcgw_digital_road_atlas_mpar_km_per_sq_km", "Digital Road Atlas MPAR roads only from local FileGDB ZIP"),
        ("spatial", "bcgw_digital_road_atlas_dpar_km_per_sq_km", "Digital Road Atlas DPAR roads only from local FileGDB ZIP"),
        ("spatial", "bcer_linear_footprint_km_per_sq_km", "BCER-only candidate: 2020 geophysical lines + 1996-2004 final plans + 2020 pipeline segments, km per LHA sq km"),
        ("spatial", "bcer_linear_footprint_new_geophysical_plans_km_per_sq_km", "BCER-only candidate with existing-clearing final-plan lines excluded, km per LHA sq km"),
        ("spatial", "bcer_geophysical_lines_km_per_sq_km", "BCER 2020 geophysical lines only, excluding handcut/aeromagnetic"),
        ("spatial", "bcer_geophysical_final_plans_km_per_sq_km", "BCER 1996-2004 geophysical final plans only, excluding handcut/aeromagnetic"),
        ("spatial", "bcer_pipeline_segments_km_per_sq_km", "BCER 2020 pipeline segments only"),
    ],
    "low_education": [
        ("census_2016", "low_education_15plus_percent", "2016 age 15+ no certificate/diploma/degree"),
        ("census_2016", "low_education_percent", "2016 age 25-64 no certificate/diploma/degree"),
        ("census_2021", "low_education_15plus_percent", "2021 age 15+ no certificate/diploma/degree"),
        ("census_2021", "low_education_percent", "2021 age 25-64 no certificate/diploma/degree"),
    ],
    "linguistic_isolation": [
        ("census_2016", "linguistic_isolation_percent", "2016 neither English nor French"),
        ("census_2021", "linguistic_isolation_percent", "2021 neither English nor French"),
    ],
    "housing_burdened_renters": [
        ("census_2016", "renter_housing_burden_percent", "2016 tenant households spending 30%+ income on shelter, DA-estimated numerator"),
        ("census_2016", "renter_housing_burden_ge50_percent", "2016 tenant shelter burden using DA published percent rows, weighted by tenant households, excluding DAs with fewer than 50 tenant households"),
        ("census_2016", "renter_housing_burden_ge30_percent", "2016 tenant shelter burden using DA published percent rows, weighted by tenant households, excluding DAs with fewer than 30 tenant households"),
        ("census_2016", "renter_housing_burden_ge20_percent", "2016 tenant shelter burden using DA published percent rows, weighted by tenant households, excluding DAs with fewer than 20 tenant households"),
        ("census_2016", "renter_housing_burden_ge100_percent", "2016 tenant shelter burden using DA published percent rows, weighted by tenant households, excluding DAs with fewer than 100 tenant households"),
        ("census_2016", "owner_housing_burden_percent", "2016 owner households spending 30%+ income on shelter, DA-estimated numerator"),
        ("census_2016", "owner_renter_housing_burden_percent_from_split", "2016 owner+tenant shelter burden rebuilt from separate owner and renter percentage rows"),
        ("census_2016", "owner_renter_housing_burden_percent_mean", "2016 mean of owner and renter shelter-burden percentages"),
        ("census_2016", "owner_plus_renter_housing_burden_percent", "2016 sum of owner and renter shelter-burden percentages; diagnostic for source definition mismatch"),
        ("census_2016", "renter_housing_burden_da_percent_unweighted", "2016 unweighted mean of DA tenant-household shelter-burden percentages"),
        ("census_2016", "owner_housing_burden_da_percent_unweighted", "2016 unweighted mean of DA owner-household shelter-burden percentages"),
        ("census_2016", "housing_burden_percent", "2016 owner+tenant households spending 30%+ income on shelter"),
        ("census_2021", "renter_housing_burden_percent", "2021 tenant households spending 30%+ income on shelter, DA-estimated numerator"),
        ("census_2021", "renter_housing_burden_ge50_percent", "2021 tenant shelter burden using DA published percent rows, weighted by tenant households, excluding DAs with fewer than 50 tenant households"),
        ("census_2021", "renter_housing_burden_ge30_percent", "2021 tenant shelter burden using DA published percent rows, weighted by tenant households, excluding DAs with fewer than 30 tenant households"),
        ("census_2021", "renter_housing_burden_ge20_percent", "2021 tenant shelter burden using DA published percent rows, weighted by tenant households, excluding DAs with fewer than 20 tenant households"),
        ("census_2021", "renter_housing_burden_ge100_percent", "2021 tenant shelter burden using DA published percent rows, weighted by tenant households, excluding DAs with fewer than 100 tenant households"),
        ("census_2021", "owner_housing_burden_percent", "2021 owner households spending 30%+ income on shelter, DA-estimated numerator"),
        ("census_2021", "owner_renter_housing_burden_percent_from_split", "2021 owner+tenant shelter burden rebuilt from separate owner and renter percentage rows"),
        ("census_2021", "owner_renter_housing_burden_percent_mean", "2021 mean of owner and renter shelter-burden percentages"),
        ("census_2021", "owner_plus_renter_housing_burden_percent", "2021 sum of owner and renter shelter-burden percentages; diagnostic for source definition mismatch"),
        ("census_2021", "renter_housing_burden_da_percent_unweighted", "2021 unweighted mean of DA tenant-household shelter-burden percentages"),
        ("census_2021", "owner_housing_burden_da_percent_unweighted", "2021 unweighted mean of DA owner-household shelter-burden percentages"),
        ("census_2021", "housing_burden_percent", "2021 owner+tenant households spending 30%+ income on shelter"),
    ],
    "low_income": [
        ("census_2016", "low_income_all_percent", "2016 LIM-AT low income, all applicable ages"),
        ("census_2016", "low_income_all_da_percent_unweighted", "2016 unweighted mean of DA all-age LIM-AT prevalence percentages"),
        ("census_2016", "lico_all_percent", "2016 LICO-AT low income, all applicable ages"),
        ("census_2016", "lico_all_da_percent_unweighted", "2016 unweighted mean of DA all-age LICO-AT prevalence percentages"),
        ("census_2016", "low_income_percent", "2016 LIM-AT low income, age 18-64"),
        ("census_2021", "low_income_all_percent", "2021 LIM-AT low income, all applicable ages"),
        ("census_2021", "low_income_all_da_percent_unweighted", "2021 unweighted mean of DA all-age LIM-AT prevalence percentages"),
        ("census_2021", "lico_all_percent", "2021 LICO-AT low income, all applicable ages"),
        ("census_2021", "lico_all_da_percent_unweighted", "2021 unweighted mean of DA all-age LICO-AT prevalence percentages"),
        ("census_2021", "low_income_percent", "2021 LIM-AT low income, age 18-64"),
    ],
    "employment_insurance_beneficiaries": [],
    "pm25": [
        ("canue_postal", "canue_postal_2012_pm25dal_a__pm25dal12_01", "CANUE portal postal-code LHA aggregate: PM2.5 v1 annual average, 2012, BC postal rows"),
        ("canue", "canue_2012_pm25dal_a__pm25dal12_01", "CANUE R2 bcHealth LHA aggregate: PM2.5 DAL 2012"),
        ("canue", "canue_2012_pm25dalb_a__pm25dal12_01", "CANUE R2 bcHealth LHA aggregate: PM2.5 DAL 2012 variant b"),
        ("canue", "canue_2012_pm25dalc_a__pm25dal12_01", "CANUE R2 bcHealth LHA aggregate: PM2.5 DAL 2012 variant c"),
        ("canue", "canue_2012_pm25dald_a__pm25dal12_01", "CANUE R2 bcHealth LHA aggregate: PM2.5 DAL 2012 variant d"),
        ("canue", "canue_2012_pm25dale_a__pm25dal12_01", "CANUE R2 bcHealth LHA aggregate: PM2.5 DAL 2012 variant e"),
        ("canue", "canue_2012_aqfpm_01_annual_mean", "CANUE R2 bcHealth LHA derived 2012 annual mean from monthly PM2.5"),
    ],
    "ozone": [
        ("canue_postal", "canue_postal_2015_o3chg_a__o3chg15_01", "CANUE portal postal-code LHA aggregate: O3 annual average, 2015, BC postal rows"),
        ("canue", "canue_2015_aqozn_mn_annual_mean", "CANUE R2 bcHealth LHA derived 2015 annual mean from monthly ozone mean"),
        ("canue", "canue_2015_o3chg_a__o3chg15_01", "CANUE R2 bcHealth LHA aggregate: 2015 ozone change/current value 01"),
        ("canue", "canue_2015_aqozn_8h_annual_mean", "CANUE R2 bcHealth LHA derived 2015 annual mean from monthly ozone 8-hour"),
    ],
    "water_quality_exceedances": [
        ("ems", "2016_2019_freshwater_qa_no_f_paper_sample_location_any_exceedance_share", "paper-specific EMS candidate: percent of freshwater EMS sample locations in each LHA with any listed threshold exceedance, 2016-2019, excluding QA F"),
        ("ems", "2016_2019_official_surface_groundwater_locations_qa_no_f_paper_sample_location_any_exceedance_share", "paper-specific EMS candidate: percent of official surface/groundwater EMS sample locations in each LHA with any listed threshold exceedance, 2016-2019, excluding QA F"),
        ("ems", "2016_2019_official_water_states_qa_no_f_paper_sample_location_any_exceedance_share", "paper-specific EMS candidate: percent of official water-state EMS sample locations in each LHA with any listed threshold exceedance, 2016-2019, excluding QA F"),
        ("ems", "2016_2019_freshwater_qa_bc_paper_sample_location_any_exceedance_share", "paper-specific EMS candidate: percent of freshwater EMS sample locations in each LHA with any listed threshold exceedance, 2016-2019, QA B/C/null"),
        ("ems", "2019_2022_all_samples_six_indicator_any_share", "provisional EMS candidate: share of six water indicator groups with any exceedance, 2019-2022, all samples"),
        ("ems", "2016_2019_freshwater_six_indicator_any_share", "provisional EMS candidate: share of six water indicator groups with any exceedance, 2016-2019, freshwater"),
        ("ems", "2015_2018_freshwater_six_indicator_any_share", "provisional EMS candidate: share of six water indicator groups with any exceedance, 2015-2018, freshwater"),
        ("ems", "2016_2019_freshwater_regular_six_indicator_any_share", "provisional EMS candidate: share of six water indicator groups with any exceedance, 2016-2019, regular freshwater"),
    ],
    "traffic_density": [
        ("traffic", "traffic_data_program_utv_aadt_m_per_sq_km", "Traffic Data Program UTV segments: MAP_RENDERING_AADT weighted by clipped segment length in metres per LHA sq km"),
        ("traffic", "traffic_data_program_utv_aadt_km_per_sq_km", "Traffic Data Program UTV segments: MAP_RENDERING_AADT weighted by clipped segment length in km per LHA sq km"),
        ("traffic", "traffic_data_program_utv_segment_km_per_sq_km", "Traffic Data Program UTV segments: clipped segment km per LHA sq km"),
        ("traffic", "traffic_data_program_utv_segment_count", "Traffic Data Program UTV segment intersection count by LHA"),
        ("traffic", "traffic_data_program_tmp_aadt_sum", "Traffic Data Program measurement points: sum of current TMP AADT values assigned to containing LHA"),
        ("traffic", "traffic_data_program_tmp_aadt_max", "Traffic Data Program measurement points: maximum current TMP AADT value assigned to containing LHA"),
        ("traffic", "traffic_data_program_tmp_point_count", "Traffic Data Program measurement points: count of TMP points assigned to containing LHA"),
        ("traffic", "traffic_data_program_tmp_aadt_sum_per_sq_km", "Traffic Data Program measurement points: sum of current TMP AADT values per LHA sq km"),
        ("traffic", "traffic_data_program_tmp_aadt_max_per_sq_km", "Traffic Data Program measurement points: maximum current TMP AADT value per LHA sq km"),
        ("traffic", "traffic_data_program_tms_report_2018_lha_aadt_sum", "Traffic Data Program generated TMS site reports: sum of 2018 annual AADT values assigned to containing LHA"),
        ("traffic", "traffic_data_program_tms_report_2018_lha_aadt_max", "Traffic Data Program generated TMS site reports: maximum 2018 annual AADT value assigned to containing LHA"),
        ("traffic", "traffic_data_program_tms_report_2018_lha_site_count", "Traffic Data Program generated TMS site reports: count of sites with parsed 2018 annual AADT assigned to containing LHA"),
        ("traffic", "traffic_data_program_tms_report_2018_lha_aadt_sum_per_sq_km", "Traffic Data Program generated TMS site reports: sum of 2018 annual AADT values per LHA sq km"),
        ("traffic", "traffic_data_program_tms_report_2018_cd_aadt_sum", "Traffic Data Program generated TMS site reports: sum of 2018 annual AADT values by LHA primary Census Division"),
        ("traffic", "traffic_data_program_tms_report_2018_cd_aadt_max", "Traffic Data Program generated TMS site reports: maximum 2018 annual AADT value by LHA primary Census Division"),
        ("traffic", "traffic_data_program_tms_report_2018_cd_site_count", "Traffic Data Program generated TMS site reports: count of sites with parsed 2018 annual AADT by LHA primary Census Division"),
        ("spatial", "bcgw_digital_road_atlas_dpar_km_per_sq_km", "Diagnostic proxy only: Digital Road Atlas DPAR road density; units do not match Shiny traffic-density values"),
        ("spatial", "bcgw_digital_road_atlas_mpar_km_per_sq_km", "Diagnostic proxy only: Digital Road Atlas MPAR road density; units do not match Shiny traffic-density values"),
        ("spatial", "paper_dedup_linear_footprint_km_per_sq_km", "Diagnostic proxy only: de-duplicated road/linear-footprint density; units do not match Shiny traffic-density values"),
    ],
    "disturbed_landscape": [
        ("ifl", "ifl_2000_disturbed_area_percent", "Intact Forest Landscapes 2000 candidate: disturbed percent = 100 - IFL area percent clipped to LHA"),
        ("ifl", "ifl_2016_disturbed_area_percent", "Intact Forest Landscapes 2016 candidate: disturbed percent = 100 - IFL area percent clipped to LHA"),
        ("disturbed", "human_disturbance_2025_rep_point_area_percent", "Modern BC Human Disturbance 2025 proxy; representative-point area assignment, not paper-era exact source"),
    ],
}

for year in ["2014", "2015", "2016", "2017", "2018"]:
    for detail_key, detail_label in [
        ("all_types_of_income_benefits", "all types of income benefits"),
        ("regular_benefits", "regular benefits"),
        ("regular_benefits_without_declared_earnings", "regular benefits without declared earnings"),
    ]:
        for denominator in ["population", "labour_force", "age_15plus"]:
            INDICATOR_CANDIDATES["employment_insurance_beneficiaries"].append(
                (
                    "ei",
                    f"statcan_ei_{year}_{detail_key}_per_100_{denominator}",
                    f"Statistics Canada 14-10-0323-01 CD annual average EI {detail_label}, both sexes age 15+, {year}, per 100 2016 CD {denominator.replace('_', ' ')}",
                )
            )

for field, label in [
    ("statcan_census_2016_ei_benefits_percent_with_amount_csd_weighted", "Statistics Canada 2016 Census 98-400-X2016119 CSD-weighted LHA percent age 15+ with any EI benefits"),
    ("statcan_census_2016_ei_regular_benefits_percent_with_amount_csd_weighted", "Statistics Canada 2016 Census 98-400-X2016119 CSD-weighted LHA percent age 15+ with EI regular benefits"),
    ("statcan_census_2016_ei_other_benefits_percent_with_amount_csd_weighted", "Statistics Canada 2016 Census 98-400-X2016119 CSD-weighted LHA percent age 15+ with EI other benefits"),
    ("statcan_census_2016_government_transfers_percent_with_amount_csd_weighted", "Statistics Canada 2016 Census 98-400-X2016119 CSD-weighted LHA percent age 15+ with government transfers"),
    ("statcan_census_2016_social_assistance_benefits_percent_with_amount_csd_weighted", "Statistics Canada 2016 Census 98-400-X2016119 CSD-weighted LHA percent age 15+ with social assistance benefits"),
]:
    INDICATOR_CANDIDATES["employment_insurance_beneficiaries"].append(("ei", field, label))

for source_key, source_label in [
    ("ei_benefits", "any EI benefits"),
    ("ei_regular_benefits", "EI regular benefits"),
    ("ei_other_benefits", "EI other benefits"),
    ("social_assistance_benefits", "social assistance benefits"),
]:
    for denominator, denominator_label in [
        ("population", "population"),
        ("labour_force", "labour force"),
        ("age_15plus", "age 15+ population"),
    ]:
        field = f"statcan_census_2016_{source_key}_estimated_with_amount_per_100_{denominator}_csd_weighted"
        INDICATOR_CANDIDATES["employment_insurance_beneficiaries"].append(
            (
                "ei",
                field,
                f"Statistics Canada 2016 Census 98-400-X2016119 CSD-weighted LHA count with {source_label}, per 100 {denominator_label}",
            )
        )

for field, label in [
    ("phsa_chsa_social_employment_rate_15_2016", "PHSA Community Health CHSA Social & economic factors, Employment Rate (15+), population-weighted to LHA"),
    ("phsa_chsa_social_sociodemographic_diversity_economic_dependency_dimention_quintile_all_ages_2022", "PHSA Community Health CHSA Social & economic factors, BCIMD economic dependency quintile, population-weighted to LHA"),
    ("phsa_chsa_social_sociodemographic_diversity_situational_vulnerability_dimention_quintile_all_ages_2022", "PHSA Community Health CHSA Social & economic factors, BCIMD situational vulnerability quintile, population-weighted to LHA"),
    ("phsa_chsa_social_physical_environment_percentage_of_people_15_commuting_to_work_by_other_means_2016", "PHSA Community Health CHSA Social & economic factors, commuting by other means, population-weighted to LHA"),
]:
    INDICATOR_CANDIDATES["employment_insurance_beneficiaries"].append(("ei", field, label))

for variant, variant_label in [
    ("all", "all parsed 2018 TMS annual AADT sites"),
    ("active", "active parsed 2018 TMS annual AADT sites"),
    ("permanent", "permanent core parsed 2018 TMS annual AADT sites"),
    ("permanent_wim", "permanent core plus WIM parsed 2018 TMS annual AADT sites"),
    ("short", "short core parsed 2018 TMS annual AADT sites"),
    ("no_ramp_turn", "parsed 2018 TMS annual AADT sites excluding ramp and directional-turn descriptions"),
    ("no_interchange_ramp_turn", "parsed 2018 TMS annual AADT sites excluding interchange, ramp, and directional-turn descriptions"),
    ("segment_max_all", "max parsed 2018 TMS annual AADT per UTV segment, retaining unsegmented sites"),
    ("segment_max_segment_only", "max parsed 2018 TMS annual AADT per UTV segment, excluding unsegmented sites"),
    ("segment_max_no_ramp_turn", "max parsed 2018 TMS annual AADT per UTV segment after excluding ramp and directional-turn descriptions"),
    (
        "segment_max_no_interchange_ramp_turn",
        "max parsed 2018 TMS annual AADT per UTV segment after excluding interchange, ramp, and directional-turn descriptions",
    ),
    ("segment_max_permanent", "max permanent-core parsed 2018 TMS annual AADT per UTV segment"),
]:
    for geography, geography_label in [("lha", "assigned to containing LHA"), ("cd", "by LHA primary Census Division")]:
        for metric, metric_label in [
            ("aadt_sum", "sum"),
            ("aadt_max", "maximum"),
            ("aadt_mean", "mean"),
            ("aadt_median", "median"),
            ("site_count", "site count"),
        ]:
            INDICATOR_CANDIDATES["traffic_density"].append(
                (
                    "traffic",
                    f"traffic_data_program_tms_report_2018_{variant}_{geography}_{metric}",
                    f"Traffic Data Program generated TMS site reports: {metric_label} of {variant_label} {geography_label}",
                )
            )
    INDICATOR_CANDIDATES["traffic_density"].append(
        (
            "traffic",
            f"traffic_data_program_tms_report_2018_{variant}_lha_aadt_sum_per_sq_km",
            f"Traffic Data Program generated TMS site reports: sum of {variant_label} assigned to containing LHA per LHA sq km",
        )
    )

for prefix, prefix_label in [
    ("traffic_data_program_utv_report_2018_lha_intersection", "2018 UTV segment-report AADT intersecting each LHA"),
    (
        "traffic_data_program_utv_report_2018_lha_representative_point",
        "2018 UTV segment-report AADT assigned to LHA by segment representative point",
    ),
    (
        "traffic_data_program_utv_report_2018_cd_representative_point",
        "2018 UTV segment-report AADT assigned by segment representative point to LHA primary Census Division",
    ),
    (
        "traffic_data_program_utv_report_2018_cd_from_lha_intersection",
        "2018 UTV segment-report AADT intersecting LHAs and summed to LHA primary Census Division",
    ),
]:
    for metric, metric_label in [
        ("aadt_sum", "sum"),
        ("aadt_max", "maximum"),
        ("aadt_mean", "mean"),
        ("aadt_median", "median"),
        ("segment_count", "segment count"),
    ]:
        INDICATOR_CANDIDATES["traffic_density"].append(
            ("traffic", f"{prefix}_{metric}", f"Traffic Data Program generated UTV segment reports: {metric_label} of {prefix_label}")
        )
    if "_lha_" in prefix:
        INDICATOR_CANDIDATES["traffic_density"].append(
            (
                "traffic",
                f"{prefix}_aadt_sum_per_sq_km",
                f"Traffic Data Program generated UTV segment reports: sum of {prefix_label} per LHA sq km",
            )
        )

for field, label in [
    (
        "traffic_data_program_utv_report_2018_lha_intersection_aadt_km",
        "Traffic Data Program generated UTV segment reports: 2018 AADT weighted by clipped segment km in each LHA",
    ),
    (
        "traffic_data_program_utv_report_2018_cd_from_lha_intersection_aadt_km",
        "Traffic Data Program generated UTV segment reports: 2018 AADT weighted by clipped segment km, summed to LHA primary Census Division",
    ),
    (
        "traffic_data_program_utv_report_2018_cd_from_lha_intersection_lha_sum",
        "Traffic Data Program generated UTV segment reports: LHA intersection sums aggregated to LHA primary Census Division",
    ),
]:
    INDICATOR_CANDIDATES["traffic_density"].append(("traffic", field, label))


def read_csv(path):
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(path):
    return json.loads(path.read_text())


def numeric(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def pearson(xs, ys):
    if len(xs) < 2:
        return None
    mx = sum(xs) / len(xs)
    my = sum(ys) / len(ys)
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 0 or vy <= 0:
        return None
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return round(cov / math.sqrt(vx * vy), 6)


def load_sources():
    canue_postal = load_canue_postal()
    ems = load_ems_candidates()
    sources = {
        "spatial": {row["lha_name"]: row for row in read_json(SPATIAL_PATH)},
        "census_2016": {row["lha_name"]: row for row in read_json(CENSUS_BASE / "2016" / "lha-socioeconomic.json")},
        "census_2021": {row["lha_name"]: row for row in read_json(CENSUS_BASE / "2021" / "lha-socioeconomic.json")},
        "canue": {row["lha_name"]: row for row in read_json(CANUE_PATH)},
        "canue_postal": {row["lha_name"]: row for row in canue_postal},
        "ems": {row["lha_name"]: row for row in ems},
        "health": {row["lha_name"]: row for row in read_json(HEALTH_PATH)} if HEALTH_PATH.exists() else {},
        "ei": {row["lha_name"]: row for row in read_json(EI_PATH)} if EI_PATH.exists() else {},
        "disturbed": {row["lha_name"]: row for row in read_json(DISTURBED_PATH)} if DISTURBED_PATH.exists() else {},
        "ifl": {row["lha_name"]: row for row in read_json(IFL_PATH)} if IFL_PATH.exists() else {},
        "traffic": {row["lha_name"]: row for row in read_json(TRAFFIC_PATH)} if TRAFFIC_PATH.exists() else {},
        "nrcan_industrial": {
            row["lha_name"]: row for row in read_json(NRCAN_INDUSTRIAL_PATH)
        }
        if NRCAN_INDUSTRIAL_PATH.exists()
        else {},
    }
    shiny = {row["lha_name"]: row for row in read_csv(SHINY_PATH)}
    return shiny, sources


def health_candidates(sources):
    fields = sorted(
        {
            field
            for row in sources.get("health", {}).values()
            for field in row
            if field.startswith("phsa_")
        }
    )
    mapping = {
        "all_causes_of_cancer": ["cancer"],
        "copd": ["copd"],
        "diabetes_mellitus": ["diabetes"],
        "hypertension": ["hypertension"],
        "low_birth_weight": ["low_birth_weight"],
    }
    candidates = defaultdict(list)
    for shiny_field, needles in mapping.items():
        for field in fields:
            if any(needle in field for needle in needles):
                notes = "PHSA Community Health Atlas LHA candidate, ranked diagnostically against the Shiny LHA table"
                if "rolling_mean" in field:
                    notes = "Diagnostic derived PHSA rolling-window candidate; compared against Shiny but excluded from best-current source selection"
                candidates[shiny_field].append(
                    (
                        "health",
                        field,
                        notes,
                    )
                )
    return candidates


def load_canue_postal():
    rows = {}
    for year in [2012, 2015]:
        path = CANUE_POSTAL_BASE / f"air-quality_{year}_aggregate.json"
        if not path.exists():
            continue
        aggregate = read_json(path)
        for source_row in aggregate.get("rows", []):
            lha_name = source_row["boundaryName"]
            row = rows.setdefault(lha_name, {"lha_id": source_row["boundaryId"], "lha_name": lha_name})
            for prop, value in source_row.get("values", {}).items():
                row[f"canue_postal_{year}_{prop}"] = value
    return list(rows.values())


def load_ems_candidates():
    if not EMS_CANDIDATES_PATH.exists():
        return []
    rows = {}
    for source_row in read_csv(EMS_CANDIDATES_PATH):
        lha_name = source_row["lha_name"]
        row = rows.setdefault(lha_name, {"lha_name": lha_name})
        row[source_row["candidate"]] = numeric(source_row.get("candidate_value"))
    return list(rows.values())


def compare_candidate(shiny, sources, shiny_field, source_id, source_field, notes):
    if source_field in {
        "bcgw_digital_road_atlas_mpar_km_per_sq_km",
        "bcgw_digital_road_atlas_dpar_km_per_sq_km",
        "paper_available_plus_dra_linear_footprint_km_per_sq_km",
        "paper_dedup_linear_footprint_km_per_sq_km",
        "forest_tenure_road_sections_not_within_1km_dra_km_per_sq_km",
    } and not (DRA_PARQUET_MPAR_PATH.exists() or DRA_GDB_PATH.exists()):
        return []
    rows = []
    for lha_name, shiny_row in shiny.items():
        source_row = sources.get(source_id, {}).get(lha_name)
        if not source_row:
            continue
        shiny_value = numeric(shiny_row.get(shiny_field))
        rebuilt_value = numeric(source_row.get(source_field))
        if shiny_value is None or rebuilt_value is None:
            continue
        rows.append(
            {
                "lha_name": lha_name,
                "shiny_field": shiny_field,
                "source_id": source_id,
                "source_field": source_field,
                "shiny_value": shiny_value,
                "rebuilt_value": rebuilt_value,
                "difference": round(rebuilt_value - shiny_value, 6),
                "absolute_difference": round(abs(rebuilt_value - shiny_value), 6),
                "notes": notes,
            }
        )
    return rows


def summarize(rows):
    if not rows:
        return None
    diffs = [row["absolute_difference"] for row in rows]
    xs = [row["shiny_value"] for row in rows]
    ys = [row["rebuilt_value"] for row in rows]
    pg = next((row for row in rows if row["lha_name"] == "Prince George"), None)
    return {
        "shiny_field": rows[0]["shiny_field"],
        "source_id": rows[0]["source_id"],
        "source_field": rows[0]["source_field"],
        "rows": len(rows),
        "mean_absolute_difference": round(sum(diffs) / len(diffs), 6),
        "max_absolute_difference": round(max(diffs), 6),
        "pearson_r": pearson(xs, ys),
        "prince_george_shiny": pg["shiny_value"] if pg else None,
        "prince_george_rebuilt": pg["rebuilt_value"] if pg else None,
        "prince_george_difference": pg["difference"] if pg else None,
        "notes": rows[0]["notes"],
    }


def choose_best(summary_rows):
    by_indicator = defaultdict(list)
    for row in summary_rows:
        by_indicator[row["shiny_field"]].append(row)
    best = []
    for indicator, rows in sorted(by_indicator.items()):
        preferred_fields = PREFERRED_CANDIDATE_FIELDS.get(indicator, set())
        preferred_rows = [row for row in rows if row["source_field"] in preferred_fields]
        if preferred_rows:
            rows = preferred_rows
        elif indicator == "hypertension":
            source_rows = [row for row in rows if "rolling_mean" not in row["source_field"]]
            if source_rows:
                rows = source_rows
        max_rows = max(row["rows"] for row in rows)
        eligible = rows
        if max_rows >= 20:
            coverage_floor = max(20, int(max_rows * 0.7))
            eligible = [row for row in rows if row["rows"] >= coverage_floor]
            if not eligible:
                eligible = rows
        if indicator == "traffic_density":
            ordered = sorted(
                eligible,
                key=lambda row: (
                    -(row["pearson_r"] if row["pearson_r"] is not None else -999),
                    row["mean_absolute_difference"],
                ),
            )
        else:
            ordered = sorted(
                eligible,
                key=lambda row: (
                    row["mean_absolute_difference"],
                    -(row["pearson_r"] if row["pearson_r"] is not None else -999),
                ),
            )
        chosen = dict(ordered[0])
        chosen["selection_rank"] = 1
        best.append(chosen)
    return best


def build_best_lha_table(shiny, sources, best_rows):
    output = []
    for lha_name, shiny_row in sorted(shiny.items()):
        row = {"lha_name": lha_name}
        for best in best_rows:
            source_row = sources[best["source_id"]].get(lha_name, {})
            shiny_value = numeric(shiny_row.get(best["shiny_field"]))
            rebuilt_value = numeric(source_row.get(best["source_field"]))
            prefix = best["shiny_field"]
            row[f"{prefix}_shiny"] = shiny_value
            row[f"{prefix}_rebuilt"] = rebuilt_value
            row[f"{prefix}_difference"] = round(rebuilt_value - shiny_value, 6) if shiny_value is not None and rebuilt_value is not None else None
            row[f"{prefix}_source"] = f"{best['source_id']}.{best['source_field']}"
        output.append(row)
    return output


def write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("")
        return
    headers = []
    for row in rows:
        for key in row:
            if key not in headers:
                headers.append(key)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    shiny, sources = load_sources()
    indicator_candidates = {key: list(value) for key, value in INDICATOR_CANDIDATES.items()}
    for shiny_field, candidates in health_candidates(sources).items():
        indicator_candidates.setdefault(shiny_field, []).extend(candidates)
    long_rows = []
    summary_rows = []
    for shiny_field, candidates in indicator_candidates.items():
        for source_id, source_field, notes in candidates:
            rows = compare_candidate(shiny, sources, shiny_field, source_id, source_field, notes)
            long_rows.extend(rows)
            summary = summarize(rows)
            if summary:
                summary_rows.append(summary)

    best_rows = choose_best(summary_rows)
    best_lha_rows = build_best_lha_table(shiny, sources, best_rows)

    write_csv(OUTPUT_DIR / "candidate-comparison-long.csv", long_rows)
    write_csv(OUTPUT_DIR / "candidate-comparison-summary.csv", summary_rows)
    write_csv(OUTPUT_DIR / "best-current-indicators.csv", best_lha_rows)
    write_csv(OUTPUT_DIR / "best-current-mapping.csv", best_rows)
    (OUTPUT_DIR / "candidate-comparison-summary.json").write_text(json.dumps(summary_rows, indent=2) + "\n")
    (OUTPUT_DIR / "best-current-indicators.json").write_text(json.dumps(best_lha_rows, indent=2) + "\n")
    (OUTPUT_DIR / "best-current-mapping.json").write_text(json.dumps(best_rows, indent=2) + "\n")
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "shinyTable": str(SHINY_PATH.relative_to(SCRIPT_DIR)),
                "sources": {
                    "spatial": str(SPATIAL_PATH.relative_to(SCRIPT_DIR)),
                    "census_2016": str((CENSUS_BASE / "2016" / "lha-socioeconomic.json").relative_to(VENDOR_ROOT)),
                    "census_2021": str((CENSUS_BASE / "2021" / "lha-socioeconomic.json").relative_to(VENDOR_ROOT)),
                    "canue": str(CANUE_PATH.relative_to(SCRIPT_DIR)),
                    "canue_postal": str(CANUE_POSTAL_BASE.relative_to(SCRIPT_DIR)),
                    "ems": str(EMS_CANDIDATES_PATH.relative_to(SCRIPT_DIR)),
                    "health": str(HEALTH_PATH.relative_to(SCRIPT_DIR)),
                    "ei": str(EI_PATH.relative_to(SCRIPT_DIR)),
                    "traffic": str(TRAFFIC_PATH.relative_to(SCRIPT_DIR)),
                    "nrcan_industrial": str(NRCAN_INDUSTRIAL_PATH.relative_to(SCRIPT_DIR)),
                },
                "selection": "Best-current mapping first applies explicit semantic preferences where candidate fields differ in measure or population, then selects by lowest mean absolute difference against the Shiny LHA table. It is a diagnostic selection, not proof of source equivalence.",
            },
            indent=2,
        )
        + "\n"
    )
    print(f"BCEnviroScreen validation harness: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
