# Jimecode Agent 源码下载

派大星 6月15日修改

下载对应语言的源码压缩包，解压后按以下步骤配置和运行。

[📦

1\_mewcode-golang.zip
355.30KB](/downloads/source/1_mewcode-golang.zip)

[📦

2\_mewcode-java.zip
87.31MB](/downloads/source/2_mewcode-java.zip)

[📦

3\_mewcode-python.zip
348.51KB](/downloads/source/3_mewcode-python.zip)

[📦

4\_mewcode-typescript.zip
347.83KB](/downloads/source/4_mewcode-typescript.zip)

## 配置 LLM 和 MCP

编辑 `.mewcode/config.yaml`，填入你的 LLM 提供商信息：

```
providers:
  - name: anthropic-official
    protocol: anthropic                    # 支持 anthropic / openai 两种协议
    base_url: https://your-api-provider.com/api/anthropic
    api_key: "your-api-key-here"
    model: claude-sonnet-4-6
    thinking: true                         # 是否开启 extended thinking

mcp_servers:
  - name: context7
    command: npx
    args: ["-y", "@upstash/context7-mcp"]
```

> **配置说明**
>
> - `protocol`：填 `anthropic` 或 `openai`，取决于你的提供商兼容哪种 API
> - `base_url`：你的 API 地址
> - `api_key`：你的 API Key
> - `model`：模型名称
> - `mcp_servers`：MCP Server 列表，每项需要 `name`、`command` 和 `args`

## 各语言启动方式

### Go

环境要求：Go 1.25+

```
# 构建
go build -o mewcode ./cmd/mewcode

# 运行
./mewcode

# 测试
go test ./...
```

### Java

环境要求：Java 21+（项目自带 Gradle Wrapper，无需单独安装）

> Windows推荐在powershell使用

```
# 构建，目前是已经构建好了，可以直接运行
gradlew shadowJar

# 运行
java -jar build/libs/mewcode.jar
```

### Python

环境要求：Python 3.11+、[uv](https://docs.astral.sh/uv/)

```
# 安装依赖
uv sync

# 运行
uv run mewcode

# 测试
uv run pytest
```
