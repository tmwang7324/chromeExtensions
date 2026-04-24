# NYC Commercial Intelligence — Workspace Instructions

## Build & Test

```bash
# Install deps (uv recommended)
uv pip install -r requirements.txt

# Run the full pipeline (data processing only; feature engineering is stubbed)
python run_pipeline.py

# Pre-compute embeddings (required before first app launch)
python -m src.embeddings          # uses cache if present
python -m src.embeddings --force  # re-embed from scratch

# Launch dashboard
streamlit run app.py

# Run tests
pytest tests/ -q
```

**Required environment variables** (`.env` at project root):
- `OPENAI_API_KEY` — text embedding via `text-embedding-3-small`
- `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`, default `claude-sonnet-4-20250514`) — agent analysis

## Architecture

`run_pipeline.py` → `src/data_processing.py` → `src/feature_engineering.py` → `data/processed/neighborhood_features_final.csv` → `app.py` (Streamlit)

| Module | Status | Role |
|---|---|---|
| `src/data_processing.py` | ✓ Complete | Clean pedestrian, subway, restaurant, retail, neighborhood CSV data |
| `src/feature_engineering.py` | ⚠️ Stub | Business density, category diversity, demographic features, persistence labels, feature matrix |
| `src/kmeans_numpy.py` | ⚠️ Stub | K-means from scratch using NumPy only — **no sklearn** |
| `src/persistence_model.py` | ⚠️ Stub | Ridge/Random Forest for commercial persistence prediction |
| `src/ranking.py` | ⚠️ Stub | Blend semantic similarity (α) + commercial activity score (β = 1−α) |
| `src/semantic_search.py` | ⚠️ Stub | Retrieval layer (equivalent functions already live in `src/embeddings.py`) |
| `src/embeddings.py` | ✓ Complete | Build text profiles, embed via OpenAI, cache to `outputs/embeddings/` |
| `src/serialization.py` | ✓ Complete | `save_joblib/load_joblib`, `save_numpy/load_numpy`, `save_dataframe/load_dataframe` |
| `src/agent.py` | ✓ Complete | Claude tool-use loop; executes **SELECT-only** DuckDB queries on filtered DataFrame |
| `app.py` | ✓ Complete | Streamlit: hard filters (DuckDB) → semantic ranking → Claude agent analysis |

## Conventions

### Python style
- `from __future__ import annotations` in every `src/` module; use PEP 604 union syntax (`str | Path`, `int | None`)
- Snake_case functions, keyword-only args for pipeline entry points (`run_data_processing(*, pedestrian_path=..., ...)`)
- Pandas: always `.rename(columns=...).copy()` to avoid `SettingWithCopyWarning`; parse with `pd.to_numeric(..., errors="coerce")`

### Borough codes
Five valid borough values: `MANHATTAN`, `BRONX`, `BROOKLYN`, `QUEENS`, `STATEN ISLAND`.
Use `standardize_borough()` from `src/data_processing.py` on any incoming borough column — it handles codes like `MN`, `BX`, `BK`, `QN`, `SI` and trailing spaces.
Community district (CD) codes encode borough as prefix: `MN` → Manhattan, `BX` → Bronx, `BK` → Brooklyn, `QN` → Queens, `SI` → Staten Island.

### Serialization
Use `src/serialization.py` helpers — `save_joblib()` for models, `save_numpy()` for arrays, `save_dataframe()` for CSVs — rather than calling joblib/numpy/pandas directly.

### Stub pattern
Unimplemented functions raise `NotImplementedError`. Tests covering stubs are decorated with `@pytest.mark.skip()`. When implementing a stub, remove both the `raise NotImplementedError` and the `skip` decorator.

## Key Pitfalls

- **`run_pipeline.py` fails at Step 2**: `run_feature_engineering()` is a stub. Data processing (Step 1) works fine; the processed CSVs in `data/processed/` were generated independently.
- **K-means must be pure NumPy**: `src/kmeans_numpy.py` is intentionally sklearn-free. Do not import sklearn in that module.
- **Embedding cache**: The app loads embeddings from `outputs/embeddings/`; if the cache is missing or stale, run `python -m src.embeddings` before launching.
- **Geospatial boundary**: `nycdta2020.shp` in `data/raw/nyc_boundaries/` provides polygon boundaries for area (km²) calculation. Use `geopandas` to read it — no other geospatial library is configured.
- **Agent SQL sandbox**: `src/agent.py` restricts Claude to `SELECT` queries only; do not add `INSERT`, `UPDATE`, or `DROP` capabilities.

## Data

Raw files live in `data/raw/`; cleaned outputs in `data/processed/`. See [data/processed/README.md](../data/processed/README.md) for column documentation.
Primary feature table consumed by the app: `data/processed/neighborhood_features_final.csv`.


## Applied Learning Copilot Instructions
- **Applied Learning Log:** The end of `copilot-instructions.md` should contain an "Applied Learning Architecture" section. This tracks session progress, pivots, and specific topics that required user reprompting or correction. When something fails repeatedly, when the user has to re-explain, or when a workaround is found for a platform/tool limitation, add a one-bullet to the "Applied Learning Architecture" section. Keep each bullet under 30 words. Minimal explanations. Do not overwrite past logs; append to them.