# GBS Software Agent

Local Agentic SW Coding

## Test it out

1. Download Ollama First : https://ollama.com/download

2. Install any models (qwen2.5-coder:3b for example)

3. Run the model : `ollama run qwen2.5-coder:3b` for eg. and the model can be change at src-> agent-> agentLoop.ts

```
response = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-coder:480b-cloud", // Here specify the model
        messages,
        stream: true,
        options: {
          temperature: 0.1,
          num_predict: 4096,
          num_ctx: 32768,
        },
      }),
      signal: abortController.signal,
    });
```

4. Build the extension with vsce and install it on vs code : https://code.visualstudio.com/api/working-with-extensions/publishing-extension
