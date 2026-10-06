# D008: Read processes on a persistent thread, one file at a time

[← Decision Index](INDEX.md)

**Date**: 2026-10-01

**Status**: Active

**Research**: [cpu-performance.md on VSY-44](https://uploads.linear.app/09589536-0763-447e-a0ed-6d9bf346d4cc/f407de70-ef2c-4341-9f06-d3fbc8eec56a/8d035065-919e-4fd3-8cd6-e4e482d6b025)

**Decision**: The program reads processes on a worker thread the collector keeps until a collection setting changes. The thread reads each file synchronously, holds the environment cache and the last counters, takes one request per sample and answers with JSON text. The dashboard and `--once` use the same thread.

**Why**: Synchronous reads cost less processor time than Bun's asynchronous ones, and a thread of vsys's own is where blocking delays no keystroke. The reads overlapped less, so a sample's elapsed time rose past the 20 ms fixture target, and that is accepted for the lower processor time.

**Rejected**: Synchronous reads on the dashboard thread, which block a keystroke for the whole read; and a new thread per sample, which pays the startup each refresh and loses the environment cache.

**Revisit when**: The 20 ms elapsed fixture target becomes a requirement again, or Bun's asynchronous file reads stop costing more processor time than synchronous ones.
