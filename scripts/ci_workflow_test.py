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
        aggregate_step = self.step(self.aggregate, "name: Require every needed job to succeed or to skip on its verdict")
        aggregate = command(aggregate_step)
        for kind, docs, path, status, application, package, accepted in rows:
            with self.subTest(kind=kind, docs=docs, path=path, status=status):
                paths.write_text(path + "\n")
                output.write_text("")
                result = self.shell(lanes, {"DOCS_ONLY": docs, "RUNNER_TEMP": str(self.root), "GITHUB_OUTPUT": str(output)})
                self.assertEqual(result.returncode, 0, result.stderr)
                lane_outputs = dict(line.split("=", 1) for line in output.read_text().splitlines())
                fields = {"needs.changes.result": status, "needs.changes.outputs.change_class": kind}
                fields.update({f"needs.changes.outputs.{key}": value for key, value in lane_outputs.items()})
                needs = {"changes": {"result": status, "outputs": {**lane_outputs, "change_class": kind}}, "bot-instructions": {"result": "success"}}
                for job, expected in (("application", application), ("arch-package", package)):
                    condition = scalar(block(self.text, f"  {job}:", 2), "if")
                    self.assertEqual(expression(condition, fields), expected)
                    self.assertFalse(expression(condition, fields, cancelled=True))
                    needs[job] = {"result": "success" if expected else "skipped"}
                waiver = expression(scalar(aggregate_step, "RENDER_ONLY"), fields)
                result = self.shell(aggregate, {"NEEDS": json.dumps(needs), "RENDER_ONLY": str(waiver).lower()})
                self.assertEqual(result.returncode == 0, accepted, result.stderr)
                if accepted:
                    # Neither a failed product job nor a skipped required
                    # instruction check is covered by the render waiver.
                    for job, failure in (("application", "failure"), ("bot-instructions", "skipped")):
                        rejected = {**needs, job: {"result": failure}}
                        result = self.shell(aggregate, {"NEEDS": json.dumps(rejected), "RENDER_ONLY": str(waiver).lower()})
                        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(expression(scalar(self.aggregate, "if"), {}))

    def test_source_diff_cannot_obtain_a_render_waiver(self):
        subject = self.root / "subject"
        subject.mkdir()
        source = subject / "src/main.ts"
        source.parent.mkdir()
        source.write_text("export const sample = 1;\n")
        git_env = {**ENV, "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid", "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
        def git(*args):
            return subprocess.check_output(["git", "-C", str(subject), *args], env=git_env, text=True, stderr=subprocess.PIPE).strip()
        git("init", "-q")
        git("add", "src/main.ts")
        git("commit", "-qm", "base")
        base = git("rev-parse", "HEAD")
        source.write_text("export const sample = 2;\n")
        git("add", "src/main.ts")
        git("commit", "-qm", "source change")
        env = {"EVENT": "pull_request", "BASE": base, "HEAD": git("rev-parse", "HEAD"), "GITHUB_OUTPUT": str(self.root / "verdict")}
        result = self.shell(command(self.step(self.changes, "id: change-class")), env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"^change_class=(trivial|micro|small|standard)\n$")
        result = self.shell(command(self.step(self.changes, "id: render-reach")), env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "render_candidate=false\n")

    def test_classifier_and_render_prerequisites_use_the_trusted_checkout(self):
        checkouts = re.findall(r"      - name: .*?\n        uses: actions/checkout@[^\n]+\n(.*?)(?=      - |\Z)", self.changes, re.S)
        self.assertTrue(any("ref: ${{ github.event.repository.default_branch }}" in checkout and "path: classifier" in checkout for checkout in checkouts))
        for header, executable in (("id: change-class", "classifier/.agents/skills/harness-ci/scripts/change-class"), ("id: render-reach", "classifier/.agents/skills/harness-ci/scripts/harness-only"), ("id: kendex", "classifier/.agents/skills/review-gate/scripts/install-latest.sh")):
            self.assertEqual(shlex.split(command(self.step(self.changes, header)))[0], executable)
        for header in ("id: kendex", "id: mirror"):
            self.assertEqual(scalar(self.step(self.changes, header), "if"), "steps.render-reach.outputs.render_candidate == 'true'")


if __name__ == "__main__":
    unittest.main()
