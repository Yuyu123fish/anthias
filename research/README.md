# Research

`research/` 只保存为项目级或跨 Feature 决定提供证据的限时调查。属于某个编号 Feature 的 Research 必须放在对应的 `specs/featurexxx-xxxxx/` 目录；具体命名见 [Feature 文档约定](../specs/README.md)。Research 用来回答明确问题，不是产品定义、Feature、Plan 或实施授权。

当前没有进行中的项目级或跨 Feature Research。

## 目录约定

一次调查使用一个带日期和主题的目录：

```text
research/
  YYYY-MM-DD-topic/
    README.md
    ...
```

调查完成或不再代表当前方向后，整个目录移入：

```text
research/archive/YYYY-MM-DD-topic/
```

不预建空目录。只有出现真实研究问题时才创建新的调查目录。

## 每次调查需要说明

- 要回答的具体问题；
- 来源优先级和检索截止时间；
- 可以确认的事实；
- Anthias 基于事实作出的推断；
- 无法证明或需要后续验证的部分；
- 调查结果将影响哪一项产品或技术决定。

研究结论需要回到稳定文档或对应 Feature 的 Spec 才能成为当前决定。归档材料只用于追溯当时的来源、推理和取舍。

## 已归档

- [2026-08-19 初始方向调查](archive/2026-08-19-initial-direction/README.md)
