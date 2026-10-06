# D007: Bound scratch traversal with a duty cycle on its own thread

[← Decision Index](INDEX.md)

**Date**: 2026-09-15

**Status**: Active

**Research**: [cpu-performance.md on VSY-44](https://uploads.linear.app/09589536-0763-447e-a0ed-6d9bf346d4cc/f407de70-ef2c-4341-9f06-d3fbc8eec56a/8d035065-919e-4fd3-8cd6-e4e482d6b025)

**Decision**: Scratch traversal runs on a worker thread that reads each directory in one listing and takes each entry's status synchronously. It works for a slice, rests until that slice is no more than its duty's share of the two, and becomes eligible again only once the rescan interval has passed since the last traversal finished. A caller that waits for the reading gets the whole thread.

**Why**: Resting is what bounds the cost. Faster reads alone leave a continuous traversal taking whatever a large root demands, and measured from its start a traversal longer than the interval was eligible again the instant it ended.

**Rejected**: An incremental filesystem index. It avoids re-reading unchanged directories, and it holds state vsys would have to keep correct against every writer on the machine.

**Revisit when**: A configured root grows large enough that a bounded traversal cannot finish within the reader's tolerance, or a kernel interface reports directory sizes without a traversal.
