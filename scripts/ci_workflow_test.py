"""Run the CI workflow's lane decisions and its trusted classifier commands."""

import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
BASH = shutil.which("bash")
if BASH is None:
    raise RuntimeError("bash is required for the CI workflow")
ENV = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}


def block(text, header, indent):
    match = re.search(rf"^{re.escape(header)}\n(.*?)(?=^ {{{indent}}}\S|\Z)", text, re.M | re.S)
    if match is None:
        raise AssertionError(f"Workflow block absent: {header}")
    return match.group(1)


def scalar(text, key):
    match = re.search(rf"^ +{re.escape(key)}: (.+)$", text, re.M)
    if match is None:
        raise AssertionError(f"Workflow field absent: {key}")
    return match.group(1)


def command(step):
    value = scalar(step, "run")
    if value not in (">-", "|"):
        return value
    body = step.split(f"        run: {value}\n", 1)[1]
    lines = []
    for line in body.splitlines():
        if line and not line.startswith("          "):
            break
        lines.append(line[10:])
    return (" " if value == ">-" else "\n").join(lines)


def expression(value, fields, cancelled=False):
    value = value.removeprefix("${{ ").removesuffix(" }}")
    value = value.replace("!cancelled()", f"'{str(cancelled).lower()}' == 'false'")
    value = value.replace("always()", "'true' == 'true'")
    value = re.sub(r"needs\.changes\.[a-z_.]+", lambda match: shlex.quote(fields.get(match.group(), "")), value)
    result = subprocess.run([BASH, "-c", f"[[ {value} ]]"], env=ENV, capture_output=True, text=True, timeout=10)
    if result.returncode not in (0, 1):
        raise AssertionError(result.stderr)
    return result.returncode == 0


class CiWorkflow(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT / ".github/workflows/ci.yml").read_text()
        self.changes = block(self.text, "  changes:", 2)
        self.aggregate = block(self.text, "  ci:", 2)
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        (self.root / "classifier").symlink_to(ROOT, target_is_directory=True)

    def step(self, job, header):
        return block(job, "      - " + header, 6)

    def shell(self, script, env=None):
        return subprocess.run([BASH, "-c", script], cwd=self.root, env={**ENV, **(env or {})}, capture_output=True, text=True, timeout=60)

    def assert_jobs_and_aggregate(self, outputs, status, application, package, accepted, workflow=None):
        workflow = self.text if workflow is None else workflow
        fields = {"needs.changes.result": status}
        fields.update({f"needs.changes.outputs.{key}": value for key, value in outputs.items()})
        needs = {"changes": {"result": status, "outputs": outputs}, "bot-instructions": {"result": "success"}}
        products = (("application", application), ("arch-package", package))
        for job, expected in products:
            condition = scalar(block(workflow, f"  {job}:", 2), "if")
            self.assertEqual(expression(condition, fields), expected, job)
            self.assertFalse(expression(condition, fields, cancelled=True), job)
            needs[job] = {"result": "success" if expected else "skipped"}
        aggregate_step = self.step(block(workflow, "  ci:", 2), "name: Require every needed job to succeed or to skip on its verdict")
        aggregate = command(aggregate_step)
        waiver = expression(scalar(aggregate_step, "RENDER_ONLY"), fields)
        env = {"NEEDS": json.dumps(needs), "RENDER_ONLY": str(waiver).lower()}
        result = self.shell(aggregate, env)
        self.assertEqual(result.returncode == 0, accepted, result.stderr)
        if accepted:
            # Every required product job must reject an unauthorized skip.
            rejections = [(job, "skipped") for job, required in products if required]
            rejections.extend((("application", "failure"), ("bot-instructions", "skipped")))
            for job, failure in rejections:
                rejected = {**needs, job: {"result": failure}}
                result = self.shell(aggregate, {**env, "NEEDS": json.dumps(rejected)})
                self.assertNotEqual(result.returncode, 0, (job, failure, outputs))

    def change_outputs(self, steps, changes):
        outputs = {}
        for line in block(changes, "    outputs:", 4).splitlines():
            key, value = line.strip().split(": ", 1)
            reference = re.fullmatch(r"\$\{\{ steps\.([a-z-]+)\.outputs\.([a-z_]+) \}\}", value)
            if reference is None:
                outputs[key] = value.strip("'\"")
            else:
                step, field = reference.groups()
                outputs[key] = steps.get(step, {}).get(field, "")
        return outputs

    def test_lane_conditions_and_aggregate_accept_only_authorized_skips(self):
        # Expected results are independent of the expressions under test.
        rows = [
            ("render", "false", "src/main.ts", "success", False, False, True),
            *[(kind, "false", "src/main.ts", "success", True, True, True) for kind in ("trivial", "micro", "small", "standard")],
            ("trivial", "true", "docs/architecture/ui.md", "success", False, False, True),
            ("trivial", "true", "README.md", "success", False, True, True),
            ("render", "false", "src/main.ts", "failure", True, True, False),
            ("", "false", "src/main.ts", "cancelled", True, True, False),
        ]
        paths = self.root / "changed-paths"
        output = self.root / "outputs"
        lanes = command(self.step(self.changes, "id: lanes"))
        for kind, docs, path, status, application, package, accepted in rows:
            with self.subTest(kind=kind, docs=docs, path=path, status=status):
                paths.write_text(path + "\n")
                output.write_text("")
                result = self.shell(lanes, {"DOCS_ONLY": docs, "RUNNER_TEMP": str(self.root), "GITHUB_OUTPUT": str(output)})
                self.assertEqual(result.returncode, 0, result.stderr)
                lane_outputs = dict(line.split("=", 1) for line in output.read_text().splitlines())
                self.assert_jobs_and_aggregate({**lane_outputs, "change_class": kind}, status, application, package, accepted)
        self.assertTrue(expression(scalar(self.aggregate, "if"), {}))

    def test_source_diff_cannot_obtain_a_render_waiver(self):
        subject = self.root / "subject"
        subject.mkdir()
        source = subject / "src/main.ts"
        source.parent.mkdir()
        source.write_text("export const sample = 1;\n")
        render_path = ".codex/config.toml"
        rendered = subject / render_path
        rendered.parent.mkdir()
        rendered.write_text("fixture render\n")
        (subject / ".kendex-generated.json").write_text(json.dumps([render_path]))
        verifier_dir = self.root / "bin"
        verifier_dir.mkdir()
        verifier = verifier_dir / "kendex"
        proof = {"version": 1, "checked": 1, "failed": 0, "rows": [{"state": "ok", "positions": [{"owns": "file", "path": render_path}]}]}
        # The shared classifier runs unchanged. Only its verifier dependency
        # returns fixture proof for the generated file.
        verifier.write_text("#!/bin/sh\ncase \"$1\" in\n--version) printf 'kendex fixture\\n' ;;\nverify) printf '%s\\n' " + shlex.quote(json.dumps(proof)) + " ;;\n*) exit 2 ;;\nesac\n")
        verifier.chmod(0o755)
        git_env = {**ENV, "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid", "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
        def git(*args):
            return subprocess.check_output(["git", "-C", str(subject), *args], env=git_env, text=True, stderr=subprocess.PIPE).strip()
        git("init", "-q")
        git("add", "src/main.ts", render_path, ".kendex-generated.json")
        git("commit", "-qm", "base")
        base = git("rev-parse", "HEAD")
        source.write_text("export const sample = 2;\n")
        git("add", "src/main.ts")
        git("commit", "-qm", "source change")
        source_head = git("rev-parse", "HEAD")
        git("checkout", "-q", "--detach", base)
        rendered.write_text("updated fixture render\n")
        git("add", render_path)
        git("commit", "-qm", "base render refresh")
        render_head = git("rev-parse", "HEAD")
        rows = (("render", base, render_head, True), ("source after base refresh", render_head, source_head, False))
        output = self.root / "verdict"

        # These copies prove that the consumer assertions reject broken
        # output forwarding, unauthorized waivers, and wrong diff arguments.
        controls = [
            ("output-render", "change_class: ${{ steps.change-class.outputs.change_class }}", "change_class: render", False),
            ("waiver-success", "RENDER_ONLY: ${{ needs.changes.outputs.change_class == 'render' }}", "RENDER_ONLY: ${{ needs.changes.result == 'success' }}", False),
            ("waiver-true", '--waiver "$RENDER_ONLY"', "--waiver true", False),
        ]
        for step in ("render-reach", "change-class"):
            original = self.step(self.changes, "id: " + step)
            controls.extend((
                (step + "-no-repo", original, original.replace("--repo subject ", ""), True),
                (step + "-reversed", original, original.replace('--base "$BASE" --head "$HEAD"', '--base "$HEAD" --head "$BASE"'), False),
            ))
        for name, base_sha, head_sha, render in rows:
            with self.subTest(diff=name):
                env = {"PATH": str(verifier_dir) + os.pathsep + ENV.get("PATH", os.defpath), "EVENT": "pull_request", "BASE": base_sha, "HEAD": head_sha, "GITHUB_OUTPUT": str(output), "RUNNER_TEMP": str(self.root)}

                def check_diff(workflow):
                    changes = block(workflow, "  changes:", 2)
                    steps = {}
                    for step in ("render-reach", "change-class", "classify", "lanes"):
                        output.write_text("")
                        if step == "lanes":
                            env["DOCS_ONLY"] = steps["classify"]["docs_only"]
                        result = self.shell(command(self.step(changes, "id: " + step)), env)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        # GitHub reads these lines to publish each step's outputs.
                        steps[step] = dict(line.split("=", 1) for line in output.read_text().splitlines())
                    self.assertEqual(steps["render-reach"]["render_candidate"], str(render).lower())
                    kind = steps["change-class"]["change_class"]
                    if render:
                        self.assertEqual(kind, "render")
                    else:
                        self.assertIn(kind, ("trivial", "micro", "small", "standard"))
                    self.assert_jobs_and_aggregate(self.change_outputs(steps, changes), "success", not render, not render, True, workflow)

                check_diff(self.text)
                for control, old, new, control_render in controls:
                    if control_render != render:
                        continue
                    with self.subTest(control=control):
                        self.assertEqual(self.text.count(old), 1)
                        defective = self.text.replace(old, new)
                        self.assertNotEqual(defective, self.text)
                        copy = self.root / (control + ".yml")
                        with copy.open("x") as fixture:
                            fixture.write(defective)
                        with self.assertRaises(AssertionError):
                            check_diff(copy.read_text())

    def test_classifier_and_render_prerequisites_use_the_trusted_checkout(self):
        checkouts = re.findall(r"      - name: .*?\n        uses: actions/checkout@[^\n]+\n(.*?)(?=      - |\Z)", self.changes, re.S)
        self.assertTrue(any("ref: ${{ github.event.repository.default_branch }}" in checkout and "path: classifier" in checkout for checkout in checkouts))
        for header, executable in (("id: change-class", "classifier/.agents/skills/harness-ci/scripts/change-class"), ("id: render-reach", "classifier/.agents/skills/harness-ci/scripts/harness-only"), ("id: kendex", "classifier/.agents/skills/review-gate/scripts/install-latest.sh")):
            self.assertEqual(shlex.split(command(self.step(self.changes, header)))[0], executable)
        for header in ("id: kendex", "id: mirror"):
            self.assertEqual(scalar(self.step(self.changes, header), "if"), "steps.render-reach.outputs.render_candidate == 'true'")


if __name__ == "__main__":
    unittest.main()
