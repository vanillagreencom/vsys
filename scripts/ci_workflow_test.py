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
ACTION = "vanillagreencom/kendex/.github/actions/change-class@main"
BOTH = "lane_application=true\nlane_package=true"
NEITHER = "lane_application=false\nlane_package=false"
# What the change-class action answers for each diff, and what the workflow
# must do with it. Columns: name, change_class, lanes (None: the classify step
# published nothing), lane_verdicts, changed_paths, the changes job's result,
# then the expected application run, arch-package run, package_readme and CI
# acceptance.
# Expected results are independent of the expressions under test.
ROWS = (
    ("claimed render refresh", "render", "true", BOTH, ".codex/config.toml", "success", True, True, "false", True),
    ("source diff", "small", "true", BOTH, "src/main.ts", "success", True, True, "false", True),
    ("README.md.bak", "small", "true", BOTH, "README.md.bak", "success", True, True, "false", True),
    ("docs-only README.md", "small", "false", NEITHER, "docs/architecture/ui.md\nREADME.md", "success", False, True, "true", True),
    ("docs-only docs/README.md", "small", "false", NEITHER, "docs/README.md", "success", False, False, "false", True),
    ("other docs-only", "trivial", "false", NEITHER, "docs/architecture/ui.md", "success", False, False, "false", True),
    # A declaration-only change selects the lane whose claims changed.
    ("package declaration change", "standard", "true", "lane_application=false\nlane_package=true", ".github/ci-lanes.conf", "success", False, True, "false", True),
    # With no lane declaration read, the action publishes no verdict and
    # lanes alone decides.
    ("no lane declaration", "small", "true", "", "src/main.ts", "success", True, True, "false", True),
    ("docs-only, no lane declaration", "trivial", "false", "", "docs/architecture/ui.md", "success", False, False, "false", True),
    ("render refresh, no lane declaration", "render", "false", "", ".codex/config.toml", "success", False, False, "false", True),
    ("failed classifier", "render", "false", NEITHER, ".codex/config.toml", "failure", True, True, "false", False),
    ("cancelled classifier", "", None, "", "", "cancelled", True, True, "", False),
)


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


def step_outputs(path):
    # GitHub reads these lines to publish a step's outputs, skipping blank ones.
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if line)


def mapping(text, steps):
    values = {}
    for line in text.splitlines():
        if line.strip().startswith("#"):
            continue
        key, value = line.strip().split(": ", 1)
        reference = re.fullmatch(r"\$\{\{ steps\.([a-z-]+)\.outputs\.([a-z_]+) \}\}", value)
        if reference is None:
            values[key] = value.strip("'\"")
        else:
            step, field = reference.groups()
            values[key] = steps.get(step, {}).get(field, "")
    return values


class CiWorkflow(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT / ".github/workflows/ci.yml").read_text()
        self.changes = block(self.text, "  changes:", 2)
        self.aggregate = block(self.text, "  ci:", 2)
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        # The changes job reads its helpers from `classifier`, the ci job from
        # `guards`: both are default-branch checkouts.
        for checkout in ("classifier", "guards"):
            (self.root / checkout).symlink_to(ROOT, target_is_directory=True)

    def step(self, job, header):
        return block(job, "      - " + header, 6)

    def shell(self, script, env=None):
        return subprocess.run([BASH, "-c", script], cwd=self.root, env={**ENV, **(env or {})}, capture_output=True, text=True, timeout=60)

    def defective(self, old, new):
        self.assertEqual(self.text.count(old), 1, old)
        defective = self.text.replace(old, new)
        copy = self.root / "defective.yml"
        copy.write_text(defective)
        return copy.read_text()

    def assert_jobs_and_aggregate(self, outputs, status, application, package, accepted, workflow):
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
        env = {"NEEDS": json.dumps(needs)}
        for line in block(aggregate_step, "        env:", 8).splitlines():
            key, value = line.strip().split(": ", 1)
            if key != "NEEDS":
                env[key] = str(expression(value, fields)).lower()
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

    def check_row(self, workflow, row):
        name, kind, lanes, verdicts, paths, status, application, package, readme, accepted = row
        changes = block(workflow, "  changes:", 2)
        steps = {}
        if lanes is not None:
            steps["classify"] = {"change_class": kind, "lanes": lanes, "lane_verdicts": verdicts, "changed_paths": paths}
            lanes_step = self.step(changes, "id: lanes")
            output = self.root / "outputs"
            output.write_text("")
            env = {**mapping(block(lanes_step, "        env:", 8), steps), "GITHUB_OUTPUT": str(output)}
            result = self.shell(command(lanes_step), env)
            self.assertEqual(result.returncode, 0, result.stderr)
            steps["lanes"] = step_outputs(output)
        outputs = mapping(block(changes, "    outputs:", 4), steps)
        self.assertEqual(outputs["package_readme"], readme, name)
        self.assert_jobs_and_aggregate(outputs, status, application, package, accepted, workflow)

    def test_lane_conditions_and_aggregate_accept_only_authorized_skips(self):
        for row in ROWS:
            with self.subTest(diff=row[0]):
                self.check_row(self.text, row)
        self.assertTrue(expression(scalar(self.aggregate, "if"), {}))

        # These copies prove that the assertions reject broken output
        # forwarding, lane conditions, README matching and waivers.
        controls = (
            ("output-lanes", "lanes: ${{ steps.classify.outputs.lanes }}", "lanes: 'true'"),
            ("output-lane-package", "lane_package: ${{ steps.lanes.outputs.lane_package }}", "lane_package: ${{ steps.lanes.outputs.lane_application }}"),
            ("readme-substring", "*$'\\n'README.md$'\\n'*) readme=true ;;", "*README.md*) readme=true ;;"),
            ("application-no-verdict", " && needs.changes.outputs.lane_application != 'false'", ""),
            ("application-no-status", "needs.changes.result != 'success' || (needs.changes.outputs.lanes != 'false' && needs.changes.outputs.lane_application", "(needs.changes.outputs.lanes != 'false' && needs.changes.outputs.lane_application"),
            ("package-no-readme", " || needs.changes.outputs.package_readme == 'true'", ""),
            ("waiver-success", "WAIVER: ${{ needs.changes.outputs.lanes == 'false' }}", "WAIVER: ${{ needs.changes.result == 'success' }}"),
            ("waiver-true", '--waiver "$WAIVER"', "--waiver true"),
            ("readme-waived", 'if [ "$PACKAGE_README" = true ]; then package=(); fi', ""),
            ("readme-not-forwarded", "PACKAGE_README: ${{ needs.changes.outputs.package_readme == 'true' }}", "PACKAGE_README: ${{ needs.changes.outputs.lanes == 'true' }}"),
        )
        for control, old, new in controls:
            with self.subTest(control=control):
                workflow = self.defective(old, new)
                with self.assertRaises(AssertionError):
                    for row in ROWS:
                        self.check_row(workflow, row)

    def test_render_reach_judges_the_subject_diff(self):
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

        # These copies prove that the assertions reject wrong diff arguments.
        original = self.step(self.changes, "id: render-reach")
        controls = (
            ("no-repo", original, original.replace("--repo subject ", ""), True),
            ("reversed", original, original.replace('--base "$BASE" --head "$HEAD"', '--base "$HEAD" --head "$BASE"'), False),
        )
        for name, base_sha, head_sha, render in rows:
            with self.subTest(diff=name):
                env = {"EVENT": "pull_request", "BASE": base_sha, "HEAD": head_sha, "GITHUB_OUTPUT": str(output)}

                def check_diff(workflow):
                    output.write_text("")
                    result = self.shell(command(self.step(block(workflow, "  changes:", 2), "id: render-reach")), env)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(step_outputs(output)["render_candidate"], str(render).lower())

                check_diff(self.text)
                for control, old, new, control_render in controls:
                    if control_render != render:
                        continue
                    with self.subTest(control=control):
                        workflow = self.defective(old, new)
                        with self.assertRaises(AssertionError):
                            check_diff(workflow)

    def check_wiring(self, workflow):
        changes = block(workflow, "  changes:", 2)
        checkouts = re.findall(r"      - name: .*?\n        uses: actions/checkout@[^\n]+\n(.*?)(?=      - |\Z)", changes, re.S)
        self.assertTrue(any("ref: ${{ github.event.repository.default_branch }}" in checkout and "path: classifier" in checkout for checkout in checkouts))
        for header, executable in (("id: render-reach", "classifier/.agents/skills/harness-ci/scripts/harness-only"), ("id: kendex", "classifier/.agents/skills/review-gate/scripts/install-latest.sh")):
            self.assertEqual(shlex.split(command(self.step(changes, header)))[0], executable)
        for header in ("id: kendex", "id: mirror"):
            self.assertEqual(scalar(self.step(changes, header), "if"), "steps.render-reach.outputs.render_candidate == 'true'")
        # Unbounded, a hung install or refresh runs to the job's timeout and
        # fails the whole changes job, where continue-on-error would have let
        # the classifier run on.
        kendex = self.step(changes, "id: kendex")
        self.assertEqual((scalar(kendex, "timeout-minutes"), scalar(kendex, "shell")), ("3", "bash"))
        self.assertEqual(scalar(self.step(changes, "id: mirror"), "timeout-minutes"), "5")
        classify = self.step(changes, "id: classify")
        self.assertEqual(scalar(classify, "uses"), ACTION)
        # The lane declaration comes from the default branch's checkout.
        inputs = dict(re.findall(r"^ {10}([a-z-]+): (.+)$", block(classify, "        with:", 8), re.M))
        self.assertEqual(inputs, {"repo": "subject", "lanes-from": "classifier", "event": "${{ env.EVENT }}", "base": "${{ env.BASE }}", "head": "${{ env.HEAD }}"})

    def test_classifier_and_render_prerequisites_use_the_trusted_checkout(self):
        self.check_wiring(self.text)
        controls = (
            ("lanes-from-subject", "lanes-from: classifier", "lanes-from: subject"),
            ("render-reach-subject", "classifier/.agents/skills/harness-ci/scripts/harness-only", "subject/.agents/skills/harness-ci/scripts/harness-only"),
            ("kendex-timeout", "        timeout-minutes: 3\n", "        timeout-minutes: 30\n"),
            ("kendex-shell", "        shell: bash\n", "        shell: sh\n"),
            ("mirror-timeout", "        timeout-minutes: 5\n        run: kendex source refresh\n", "        timeout-minutes: 50\n        run: kendex source refresh\n"),
        )
        for control, old, new in controls:
            with self.subTest(control=control):
                workflow = self.defective(old, new)
                with self.assertRaises(AssertionError):
                    self.check_wiring(workflow)

    def check_guards(self, workflow):
        ci = block(workflow, "  ci:", 2)
        steps = re.split(r"^      - ", ci, flags=re.M)[1:]
        trusted = [step for step in steps if "uses: actions/checkout@" in step and "ref: ${{ github.event.repository.default_branch }}" in step]
        self.assertEqual(len(trusted), 1, trusted)
        guards = trusted[0]
        self.assertIn("          path: guards\n", guards)
        # aggregate-needs runs on every event, so its checkout has no if:.
        self.assertNotRegex(guards, r"(?m)^ +if:")
        self.assertEqual(set(re.findall(r"([\w-]+)/\.agents/skills/", ci)), {"guards"})

    def test_ci_job_reads_every_helper_from_one_guards_checkout(self):
        self.check_guards(self.text)
        controls = (
            ("guards-if", "      - name: the credential guards and skip judge, from the default branch\n", "      - name: the credential guards and skip judge, from the default branch\n        if: github.event_name == 'pull_request'\n"),
            ("guards-path", "          path: guards\n", "          path: trusted\n"),
            ("aggregate-classifier", "          guards/.agents/skills/harness-ci/scripts/aggregate-needs", "          classifier/.agents/skills/harness-ci/scripts/aggregate-needs"),
            ("second-checkout", "      # Kept beside aggregate-needs", "      - name: The aggregate helper, from the default branch\n        uses: actions/checkout@v7\n        with:\n          ref: ${{ github.event.repository.default_branch }}\n          path: classifier\n      # Kept beside aggregate-needs"),
        )
        for control, old, new in controls:
            with self.subTest(control=control):
                workflow = self.defective(old, new)
                with self.assertRaises(AssertionError):
                    self.check_guards(workflow)


if __name__ == "__main__":
    unittest.main()
