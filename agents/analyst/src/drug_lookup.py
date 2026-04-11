"""RxNav-backed antidepressant classification helpers."""

import requests
import time


class DrugLookup:
    """Classify drugs as antidepressants using RxNav RxClass."""

    def __init__(self):
        self._cache = {}
        self._session = requests.Session()

    @staticmethod
    def _normalize_key(drug_name):
        if not drug_name:
            return None
        key = str(drug_name).strip().lower()
        return key or None

    def lookup_antidepressant_class(self, drug_name, timeout=20):
        """Return (is_antidepressant, class_name) from RxNav RxClass.

        For non-antidepressants, class_name is a representative RxClass class.
        """
        cache_key = self._normalize_key(drug_name)
        if not cache_key:
            return False, None
        if cache_key in self._cache:
            return self._cache[cache_key]

        url = "https://rxnav.nlm.nih.gov/REST/rxclass/class/byDrugName.json"
        params = {"drugName": str(drug_name).strip()}

        try:
            response = self._session.get(url, params=params, timeout=timeout)
            response.raise_for_status()
            payload = response.json()
        except Exception:
            result = (False, None)
            self._cache[cache_key] = result
            return result

        class_items = payload.get("rxclassDrugInfoList", {}).get("rxclassDrugInfo", [])
        antidepressant_like_name = None
        first_class_name = None
        for item in class_items:
            class_info = item.get("rxclassMinConceptItem", {})
            class_id = class_info.get("classId")
            class_name_raw = class_info.get("className")
            class_name = (class_name_raw or "").lower()
            rela_source = (item.get("relaSource") or "").upper()
            if class_name_raw and first_class_name is None:
                first_class_name = class_name_raw

            if class_id == "N06A" and rela_source == "ATC":
                result = (True, class_name_raw or "Antidepressants")
                self._cache[cache_key] = result
                return result
            if "antidepressant" in class_name and antidepressant_like_name is None:
                antidepressant_like_name = class_name_raw

        if antidepressant_like_name:
            result = (True, antidepressant_like_name)
            self._cache[cache_key] = result
            return result
        result = (False, first_class_name)
        self._cache[cache_key] = result
        return result

    def is_antidepressant(self, drug_name, timeout=20):
        """Return True if RxNav classifies the drug as an antidepressant."""
        is_ad, class_name = self.lookup_antidepressant_class(drug_name=drug_name, timeout=timeout)
        key = self._normalize_key(drug_name)
        if key is None:
            is_ad, class_name = (False, None)
        else:
            is_ad, class_name = self._cache.get(key, (False, None))
        return is_ad, class_name

    def bulk_antidepressant_lookup(self, drug_names, timeout=20):
        """Batch antidepressant lookup for a list of drug names.

        Returns one dict per input item with:
        {"drug": original_input, "is_antidepressant": bool, "class_name": str|None}
        """
        if not drug_names:
            return []

        unique_queries = {}
        for drug in drug_names:
            key = self._normalize_key(drug)
            if key is None:
                continue
            if key not in unique_queries:
                unique_queries[key] = str(drug).strip()

        min_interval_seconds = 0.06
        last_api_hit_at = None
        for query_key, query_name in unique_queries.items():
            if query_key in self._cache:
                continue

            now = time.monotonic()
            if last_api_hit_at is not None:
                elapsed = now - last_api_hit_at
                if elapsed < min_interval_seconds:
                    time.sleep(min_interval_seconds - elapsed)

            self.lookup_antidepressant_class(drug_name=query_name, timeout=timeout)
            last_api_hit_at = time.monotonic()

        results = []
        for drug in drug_names:
            is_ad, class_name = self.is_antidepressant(drug)
            results.append(
                {
                    "drug": drug,
                    "is_antidepressant": bool(is_ad),
                    "class_name": class_name,
                }
            )
        return results
