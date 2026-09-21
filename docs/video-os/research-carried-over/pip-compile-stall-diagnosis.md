# Pip-Compile Resolver Stall Diagnosis

**Authority:** L0 read-only investigation. No lock file was generated in the repository, no commit was made, and no worker, validation, workflow, authorization, or risk-acceptance state was changed.

## 1. Network reachability

**CONFIRMED:** A disposable `python:3.8-slim` container received HTTP `200` from both `https://pypi.org/simple/pip/` and `https://files.pythonhosted.org/` using Python's standard URL client. The prior resolver silence is not explained by a blanket container-network restriction.

## 2. Bounded verbose full-resolution probe

**CONFIRMED:** The target environment was Linux `x86_64`, Python `3.8`, CUDA `11.3`, and the PyTorch CUDA index with `torch==1.12.1+cu113`, `torchvision==0.13.1+cu113`, and `torchaudio==0.12.1`.

**CONFIRMED:** `pip-tools==7.4.1` installed successfully under Python 3.8. A verbose `pip-compile --resolver=backtracking --generate-hashes` probe was bounded by `timeout 180` and exited with code `124` (timeout), not a resolver exception.

Captured last-visible resolver state:

```text
Looking in indexes: https://pypi.org/simple, https://download.pytorch.org/whl/cu113
Collecting torch==1.12.1+cu113
Downloading ... torch-1.12.1+cu113-cp38-cp38-linux_x86_64.whl (1837.7 MB)
Collecting torchvision==0.13.1+cu113
Collecting torchaudio==0.12.1
Collecting numpy==1.23.4
...
Collecting scikit-image==0.19.3
```

**LIKELY:** The earlier perceived stall was large-artifact acquisition and broad dependency resolution, not a silent failure. The full probe had not reached `gradio` or `gfpgan` when the bounded timeout expired.

## 3. Isolated unpinned-subset probe

**CONFIRMED:** A separate bounded container probe resolved only `numba`, `tqdm`, `pyyaml`, `av`, and `safetensors`, excluding `gradio` and `gfpgan`. It exited `0` in under 30 seconds and emitted a hash-locked result to container-local `/tmp/subset.lock`.

**CONFIRMED:** The subset therefore does not reproduce the timeout. In particular, the five unpinned packages named above are not by themselves sufficient to cause it.

**UNKNOWN:** This does not prove `gradio` or `gfpgan` are harmless or causal. The bounded full probe timed out before reaching either package, so no evidence isolates them as the source.

## 4. Resolver options

**CONFIRMED:** `pip-compile --help` for pip-tools `7.4.1` exposes:

```text
--resolver [legacy|backtracking]
```

The timed full probe used `backtracking`. No legacy-resolver probe was run because this mission is diagnostic only and did not generate a repository lock.

## 5. Python 3.8 compatibility

**CONFIRMED:** pip-tools `7.4.1` installed and ran under Python 3.8 in the selected container, including a successful subset resolution. There is no observed Python-3.8/pip-tools execution incompatibility in this investigation.

**UNKNOWN:** This evidence does not rule out package-specific Python 3.8 availability constraints in the full SadTalker graph. The full resolution did not finish, so it did not reach a final compatibility verdict.

## Conclusion boundary

No repository lock was generated or committed. The discriminating evidence supports a bounded-resolution-duration problem centered on the large CUDA torch artifact and broad graph, not a blanket network restriction or the isolated five unpinned packages. It does not identify a final full-graph resolver result or prescribe a lock-generation method.
