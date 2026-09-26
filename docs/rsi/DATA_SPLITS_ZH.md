# 人工指定训练、验证与测试集

生产入口要求 `dataSplitManifest`。四套 Agent 保留原来的起始方法和 Early/Latest 搜索机制，共享同一套数据边界：训练 Gold 可读，RSI 迭代阶段只评测训练集；候选冻结后再单独评测验证集，测试只在候选冻结后执行。

## 1. 指定数据，不在源码中固定分组

训练和验证 split 使用一个 JSON 蛋白清单，支持顶层数组或 `{"proteins": [...]}`：

```json
{
  "proteins": [
    {"proteinId": "example-1", "sequence": "example-1.fasta", "structure": "example-1.pdb", "gold": "example-1.txt"}
  ]
}
```

`sequence` 必须指向单条记录的 FASTA；`structure` 可省略或为 null。输入文件路径相对该 JSON 所在目录，也可使用绝对路径。`gold`（兼容 `goldGoIds`）相对该 split 的 `goldRoot`，必须落在该目录内；Gold 使用每行一个 GO ID 的文本格式。需要额外转换的 cohort/group/蛋白 ID 选择，应先由操作者生成这三个明确的清单。

复制 `examples/data-split.draft.template.json`，填写三份清单及 Gold 目录的真实绝对路径；路径应先解析符号链接。训练、验证的蛋白 ID 和规范化氨基酸序列必须互不重叠，不能通过更换 FASTA 标题规避检测。可另外开启结构文件哈希去重。跨集合不能共享同一个被授权文件。

## 2. 冻结并检查数据清单

```bash
python3 scripts/validate_data_split.py --manifest /data/split.draft.json --seal-output /data/split.sealed.json
python3 scripts/validate_data_split.py --manifest /data/split.sealed.json
```

seal 命令拒绝覆盖已有输出，并生成每个引用文件的 SHA-256 清单及整个 manifest 的 canonicalHash。之后更改任何蛋白、结构、Gold 或清单都会使验证失败。修改数据需要创建新的划分和 campaign，不能在原实验中重新封存后继续。

所有生产初始化、恢复和 worker 运行都会检查绑定。旧的、不含 `fileHashes` 的未完成三分清单必须重新生成；已经冻结的历史 campaign 不应就地迁移。历史合成测试仍可使用无数据绑定的非生产接口。

## 3. 启动 RSI

验证集的 `evaluationPhase` 使用 `after_freeze_only` 时，RSI worker 会向私有 evaluator 注入 `PI_AUTONOMOUS_RSI_EVALUATION_SPLIT=training`，因此每轮迭代只读取训练 Gold。冻结候选后，验证入口应使用同一份 manifest 并设置 `PI_AUTONOMOUS_RSI_EVALUATION_SPLIT=validation`；该调用不回写 RSI 候选选择记录。旧的 `during_rsi` 清单会被拒绝，避免无意中恢复每轮训练集加验证集的昂贵流程。


Early 使用 `examples/early-rsi-production-profile.template.json`；Latest 使用 `examples/autonomous-rsi-production-profile.template.json`。填写 `dataSplitManifest`、evaluator command/contract、运行目录和预算。

```bash
./pi-agent rsi early-rsi-production-start --profile /private/production-profile.json
# Latest 对应：
./pi-agent rsi autonomous-rsi-production-start --profile /private/production-profile.json
```

本机建议使用共享 Linux launcher 生成完整的 evaluator、最终测试 contract 和 profile：

```bash
python3 ../.iclr-host/linux-adapted-v1/bin/campaign_launcher_linux.py prepare --request /private/launch-request.json
python3 ../.iclr-host/linux-adapted-v1/bin/campaign_launcher_linux.py start --campaign-root /absolute/prepared-campaign
```

launcher 的 request 示例见 `.iclr-host/linux-adapted-v1/campaign_launch_request.template.json`。使用与当前干净提交/tree 完全匹配的版本化 baseline；历史 G0、原有 toolbox 和已有 campaign 不会自动更新为新框架。先完成新版本的审查、提交和 baseline 注册，再启动正式实验。

开发 worker 通过 `training_read` 读取训练资源：先请求 `proteins-file`，再请求 `proteins/<相对路径>` 或 `gold/<相对路径>`；绝对行路径可放在对应前缀后。只授权 manifest 明确列出的训练文件，不授权同目录其他文件。工具只读，训练标签不写入候选仓库。单次读取当前限制 200000 字节。

方法迭代必须防止对 training Gold 过拟合。蛋白/类别硬编码和只提高训练分数的特殊规则不能作为泛化改进；应提出机制依据、预先确定预期效果和失败条件，再用聚合验证指标决定保留或回滚。Latest 的任务描述也会进入 diagnose/plan/develop 提示并在恢复时检查。

## 4. 冻结并运行最终测试

共享 Linux launcher 创建的 campaign 使用：

```bash
python3 ../.iclr-host/linux-adapted-v1/bin/final_test_evaluator_linux.py freeze --campaign-root /absolute/prepared-campaign
python3 ../.iclr-host/linux-adapted-v1/bin/final_test_evaluator_linux.py evaluate --campaign-root /absolute/prepared-campaign
```

冻结命令先验证 controller ledger：Early 选择实际保留且已评测的候选，Latest 选择验证成绩决定的候选。绑定 commit、tree、state、spec、数据划分和最终测试 contract，不接受调用者另指定候选。冻结后生产启动入口拒绝继续迭代。

最终测试只使用这个 commit，独立保存聚合结果，不回传给 RSI 选择流程。重复调用返回既有结果；中断只能重试相同冻结绑定。已经生成但未通过 artifact validation 的预测不作为有效缓存复用；不同数据/配置不会共用评测缓存。

Linux 当前采用 rooted 开发工具、私有 evaluator 配置和清理后的预测子进程环境，保护的是框架提供的数据通道；同一 Unix 用户任意执行代码的 OS 权限隔离并未增加。配置不再错误宣称 `sandbox_denied`。这些边界与原有严格安全沙箱的科学声明应分别记录。

## 5. 验证与版本身份

运行 `npm test`、`npm run test:rsi` 和 Host 的 `python3 -m unittest discover -s ../.iclr-host/linux-adapted-v1/tests -v`。后者覆盖跨语言封存、数据变更/重复、Gold 路径逃逸、冻结前拒绝测试、冻结后防换候选、结果幂等和预测缓存验证。

`python3 scripts/verify_rsi_release.py` 验证当前框架的操作版本文件清单。历史 `CODEBASE_COMPOSITION.json` 和 R09 source provenance 保留原始身份，因此原先要求“现有文件逐字等于历史 G0”的脚本可能报告历史漂移，不能据此把本次操作版本冒充为原始 G0。当前代码验证与真实独立测试集上的科学结论是两件事。
