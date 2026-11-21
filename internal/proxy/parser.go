package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
)

type ParsedToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ParsedToolResult struct {
	ToolCallID string `json:"tool_call_id"`
	Content    string `json:"content"`
}

type ParsedMessage struct {
	Role        string             `json:"role"`
	Content     string             `json:"content"`
	Reasoning   string             `json:"reasoning,omitempty"`
	ToolCalls   []ParsedToolCall   `json:"tool_calls,omitempty"`
	ToolResults []ParsedToolResult `json:"tool_results,omitempty"`
}

type ParsedExchange struct {
	Protocol          string           `json:"protocol"`
	Model             string           `json:"model"`
	RequestedModel    string           `json:"requested_model,omitempty"`
	ResponseModel     string           `json:"response_model,omitempty"`
	IsStream          bool             `json:"is_stream"`
	ResponseID        string           `json:"response_id,omitempty"`
	FinishReason      string           `json:"finish_reason,omitempty"`
	SystemPrompt      string           `json:"system_prompt,omitempty"`
	RequestMessages   []ParsedMessage  `json:"request_messages,omitempty"`
	ToolDefinitions   []map[string]any `json:"tool_definitions,omitempty"`
	AssistantText     string           `json:"assistant_text,omitempty"`
	ReasoningContent  string           `json:"reasoning_content,omitempty"`
	ToolCalls         []ParsedToolCall `json:"tool_calls,omitempty"`
	PromptTokens      int              `json:"prompt_tokens"`
	CompletionTokens  int              `json:"completion_tokens"`
	CachedTokens      int              `json:"cached_tokens"`
	CacheCreateTokens int              `json:"cache_create_tokens,omitempty"`
	ReasoningTokens   int              `json:"reasoning_tokens,omitempty"`
	ClientIP          string           `json:"client_ip,omitempty"`
	APIKeyHash        string           `json:"api_key_hash,omitempty"`
	Metadata          map[string]any   `json:"metadata,omitempty"`
}

type SSEEvent struct {
	Index int    `json:"index"`
	Event string `json:"event"`
	Data  string `json:"data"`
}

type ResponseMetadata struct {
	ResponseModel string
	ResponseID    string
	FinishReason  string
	IsStream      bool
}

func DetectProtocol(path string) string {
	p := strings.ToLower(path)
	switch {
	case strings.HasSuffix(p, "/chat/completions"):
		return "openai_chat"
	case strings.HasSuffix(p, "/responses"):
		return "openai_responses"
	case strings.HasSuffix(p, "/messages"):
		return "anthropic_messages"
	default:
		return "unknown"
	}
}

func ParseExchange(path string, reqHeaders http.Header, reqBody []byte, respHeaders http.Header, respBody []byte) *ParsedExchange {
	proto := DetectProtocol(path)
	res := &ParsedExchange{
		Protocol:   proto,
		APIKeyHash: ExtractAPIKeyHash(reqHeaders),
	}
	reqPlain := DecompressIfGzip(reqHeaders, reqBody)
	respPlain := DecompressIfGzip(respHeaders, respBody)

	ct := strings.ToLower(respHeaders.Get("Content-Type"))
	isSSE := strings.Contains(ct, "text/event-stream") || LooksLikeSSE(respPlain)
	res.IsStream = isSSE

	switch proto {
	case "openai_chat":
		parseOpenAIChatRequest(reqPlain, res)
		if isSSE {
			parseOpenAIChatSSE(respPlain, res)
		} else {
			parseOpenAIChatJSON(respPlain, res)
		}
	case "openai_responses":
		parseOpenAIResponsesRequest(reqPlain, res)
		if isSSE {
			parseOpenAIResponsesSSE(respPlain, res)
		} else {
			parseOpenAIResponsesJSON(respPlain, res)
		}
	case "anthropic_messages":
		parseAnthropicRequest(reqPlain, res)
		if isSSE {
			parseAnthropicSSE(respPlain, res)
		} else {
			parseAnthropicJSON(respPlain, res)
		}
	}
	return res
}

func LooksLikeSSE(b []byte) bool {
	trimmed := bytes.TrimSpace(b)
	return bytes.HasPrefix(trimmed, []byte("data:")) || bytes.HasPrefix(trimmed, []byte("event:"))
}

func parseOpenAIChatRequest(body []byte, out *ParsedExchange) {
	var req struct {
		Model    string           `json:"model"`
		Stream   bool             `json:"stream"`
		Tools    []map[string]any `json:"tools"`
		Messages []struct {
			Role             string          `json:"role"`
			Content          json.RawMessage `json:"content"`
			ReasoningContent string          `json:"reasoning_content"`
			Reasoning        string          `json:"reasoning"`
			ToolCallID       string          `json:"tool_call_id"`
			ToolCalls        []struct {
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return
	}
	if req.Model != "" {
		out.RequestedModel = req.Model
		if out.Model == "" {
			out.Model = req.Model
		}
	}
	if req.Stream {
		out.IsStream = true
	}
	if len(req.Tools) > 0 {
		out.ToolDefinitions = req.Tools
	}
	var sysParts []string
	for _, m := range req.Messages {
		text := extractTextFromRaw(m.Content)
		if m.Role == "system" || m.Role == "developer" {
			if text != "" {
				sysParts = append(sysParts, text)
			}
			out.RequestMessages = append(out.RequestMessages, ParsedMessage{
				Role:    "system",
				Content: text,
			})
			continue
		}
		if m.Role == "tool" {
			out.RequestMessages = append(out.RequestMessages, ParsedMessage{
				Role: "tool",
				ToolResults: []ParsedToolResult{
					{ToolCallID: m.ToolCallID, Content: text},
				},
			})
			continue
		}
		reasoning := m.ReasoningContent
		if reasoning == "" {
			reasoning = m.Reasoning
		}
		pm := ParsedMessage{
			Role:      m.Role,
			Content:   text,
			Reasoning: reasoning,
		}
		for _, tc := range m.ToolCalls {
			pm.ToolCalls = append(pm.ToolCalls, ParsedToolCall{
				ID:        tc.ID,
				Name:      tc.Function.Name,
				Arguments: tc.Function.Arguments,
			})
		}
		out.RequestMessages = append(out.RequestMessages, pm)
	}
	if len(sysParts) > 0 {
		out.SystemPrompt = strings.Join(sysParts, "\n\n")
	}
}

func parseOpenAIChatJSON(body []byte, out *ParsedExchange) {
	var resp struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content          json.RawMessage `json:"content"`
				ReasoningContent string          `json:"reasoning_content"`
				Reasoning        string          `json:"reasoning"`
				ToolCalls        []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens        int `json:"prompt_tokens"`
			CompletionTokens    int `json:"completion_tokens"`
			PromptTokensDetails struct {
				CachedTokens int `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			CompletionTokensDetails struct {
				ReasoningTokens int `json:"reasoning_tokens"`
			} `json:"completion_tokens_details"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return
	}
	if resp.ID != "" {
		out.ResponseID = resp.ID
	}
	if resp.Model != "" {
		out.ResponseModel = resp.Model
		out.Model = resp.Model
	}
	if len(resp.Choices) > 0 {
		c := resp.Choices[0]
		out.FinishReason = c.FinishReason
		out.AssistantText = extractTextFromRaw(c.Message.Content)
		if c.Message.ReasoningContent != "" {
			out.ReasoningContent = c.Message.ReasoningContent
		} else if c.Message.Reasoning != "" {
			out.ReasoningContent = c.Message.Reasoning
		}
		for _, tc := range c.Message.ToolCalls {
			out.ToolCalls = append(out.ToolCalls, ParsedToolCall{
				ID:        tc.ID,
				Name:      tc.Function.Name,
				Arguments: tc.Function.Arguments,
			})
		}
	}
	out.PromptTokens = resp.Usage.PromptTokens
	out.CompletionTokens = resp.Usage.CompletionTokens
	out.CachedTokens = resp.Usage.PromptTokensDetails.CachedTokens
	out.ReasoningTokens = resp.Usage.CompletionTokensDetails.ReasoningTokens
}

func parseOpenAIChatSSE(body []byte, out *ParsedExchange) {
	var textBuf strings.Builder
	var reasonBuf strings.Builder
	type tcAcc struct {
		id   string
		name string
		args strings.Builder
	}
	tcMap := map[int]*tcAcc{}

	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var chunk struct {
			ID      string `json:"id"`
			Model   string `json:"model"`
			Choices []struct {
				FinishReason string `json:"finish_reason"`
				Delta        struct {
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
					Reasoning        string `json:"reasoning"`
					ToolCalls        []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens        int `json:"prompt_tokens"`
				CompletionTokens    int `json:"completion_tokens"`
				PromptTokensDetails struct {
					CachedTokens int `json:"cached_tokens"`
				} `json:"prompt_tokens_details"`
				CompletionTokensDetails struct {
					ReasoningTokens int `json:"reasoning_tokens"`
				} `json:"completion_tokens_details"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		if chunk.ID != "" && out.ResponseID == "" {
			out.ResponseID = chunk.ID
		}
		if chunk.Model != "" {
			out.ResponseModel = chunk.Model
			out.Model = chunk.Model
		}
		if len(chunk.Choices) > 0 {
			c := chunk.Choices[0]
			if c.FinishReason != "" {
				out.FinishReason = c.FinishReason
			}
			if c.Delta.Content != "" {
				textBuf.WriteString(c.Delta.Content)
			}
			if c.Delta.ReasoningContent != "" {
				reasonBuf.WriteString(c.Delta.ReasoningContent)
			} else if c.Delta.Reasoning != "" {
				reasonBuf.WriteString(c.Delta.Reasoning)
			}
			for _, tc := range c.Delta.ToolCalls {
				acc, ok := tcMap[tc.Index]
				if !ok {
					acc = &tcAcc{}
					tcMap[tc.Index] = acc
				}
				if tc.ID != "" {
					acc.id = tc.ID
				}
				if tc.Function.Name != "" {
					acc.name = tc.Function.Name
				}
				if tc.Function.Arguments != "" {
					acc.args.WriteString(tc.Function.Arguments)
				}
			}
		}
		if chunk.Usage != nil {
			out.PromptTokens = chunk.Usage.PromptTokens
			out.CompletionTokens = chunk.Usage.CompletionTokens
			out.CachedTokens = chunk.Usage.PromptTokensDetails.CachedTokens
			out.ReasoningTokens = chunk.Usage.CompletionTokensDetails.ReasoningTokens
		}
	}
	out.AssistantText = textBuf.String()
	out.ReasoningContent = reasonBuf.String()
	if len(tcMap) > 0 {
		indices := make([]int, 0, len(tcMap))
		for idx := range tcMap {
			indices = append(indices, idx)
		}
		sort.Ints(indices)
		for _, idx := range indices {
			acc := tcMap[idx]
			out.ToolCalls = append(out.ToolCalls, ParsedToolCall{
				ID:        acc.id,
				Name:      acc.name,
				Arguments: acc.args.String(),
			})
		}
	}
}

func parseOpenAIResponsesRequest(body []byte, out *ParsedExchange) {
	var req struct {
		Model              string `json:"model"`
		Stream             bool   `json:"stream"`
		Instructions       string `json:"instructions"`
		PromptCacheKey     string `json:"prompt_cache_key"`
		PreviousResponseID string `json:"previous_response_id"`
		Reasoning          *struct {
			Effort  string `json:"effort"`
			Summary string `json:"summary"`
		} `json:"reasoning"`
		Tools []map[string]any `json:"tools"`
		Input json.RawMessage  `json:"input"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return
	}
	if req.Model != "" {
		out.RequestedModel = req.Model
		if out.Model == "" {
			out.Model = req.Model
		}
	}
	if req.Stream {
		out.IsStream = true
	}
	if req.Reasoning != nil && req.Reasoning.Effort != "" {
		setExchangeMeta(out, "reasoning_effort", req.Reasoning.Effort)
	}
	if req.PromptCacheKey != "" {
		setExchangeMeta(out, "prompt_cache_key", req.PromptCacheKey)
	}
	if req.PreviousResponseID != "" {
		setExchangeMeta(out, "previous_response_id", req.PreviousResponseID)
	}
	if len(req.Tools) > 0 {
		out.ToolDefinitions = normalizeToolDefinitions(req.Tools)
	}
	var sysParts []string
	if req.Instructions != "" {
		sysParts = append(sysParts, req.Instructions)
		out.RequestMessages = append(out.RequestMessages, ParsedMessage{
			Role:    "system",
			Content: req.Instructions,
		})
	}
	var strInput string
	if err := json.Unmarshal(req.Input, &strInput); err == nil && strInput != "" {
		out.RequestMessages = append(out.RequestMessages, ParsedMessage{
			Role:    "user",
			Content: strInput,
		})
		if len(sysParts) > 0 {
			out.SystemPrompt = strings.Join(sysParts, "\n\n")
		}
		return
	}
	var items []map[string]json.RawMessage
	if err := json.Unmarshal(req.Input, &items); err != nil {
		if len(sysParts) > 0 {
			out.SystemPrompt = strings.Join(sysParts, "\n\n")
		}
		return
	}

	var pendingAssistant *ParsedMessage
	flushAssistant := func() {
		if pendingAssistant != nil {
			out.RequestMessages = append(out.RequestMessages, *pendingAssistant)
			pendingAssistant = nil
		}
	}
	ensureAssistant := func() *ParsedMessage {
		if pendingAssistant == nil {
			pendingAssistant = &ParsedMessage{Role: "assistant"}
		}
		return pendingAssistant
	}

	for _, item := range items {
		var itemType, role string
		_ = json.Unmarshal(item["type"], &itemType)
		_ = json.Unmarshal(item["role"], &role)
		switch itemType {
		case "reasoning":
			rText := extractTextFromRaw(item["summary"])
			if rText == "" {
				rText = extractTextFromRaw(item["content"])
			}
			if rText != "" {
				pa := ensureAssistant()
				if pa.Reasoning == "" {
					pa.Reasoning = rText
				} else {
					pa.Reasoning += "\n" + rText
				}
			}
		case "function_call":
			var callID, itemID, name string
			_ = json.Unmarshal(item["call_id"], &callID)
			_ = json.Unmarshal(item["id"], &itemID)
			_ = json.Unmarshal(item["name"], &name)
			if callID == "" {
				callID = itemID
			}
			args := extractRawStringOrJSON(item["arguments"])
			pa := ensureAssistant()
			pa.ToolCalls = append(pa.ToolCalls, ParsedToolCall{
				ID:        callID,
				Name:      name,
				Arguments: args,
			})
		case "function_call_output":
			flushAssistant()
			var callID, itemID string
			_ = json.Unmarshal(item["call_id"], &callID)
			_ = json.Unmarshal(item["id"], &itemID)
			if callID == "" {
				callID = itemID
			}
			output := extractOutputFromRaw(item["output"])
			out.RequestMessages = append(out.RequestMessages, ParsedMessage{
				Role: "tool",
				ToolResults: []ParsedToolResult{
					{ToolCallID: callID, Content: output},
				},
			})
		default:
			if role != "" {
				text := extractTextFromRaw(item["content"])
				if role == "assistant" {
					pa := ensureAssistant()
					if text != "" {
						if pa.Content == "" {
							pa.Content = text
						} else {
							pa.Content += "\n" + text
						}
					}
					continue
				}
				flushAssistant()
				if role == "developer" || role == "system" {
					if text != "" {
						sysParts = append(sysParts, text)
					}
					role = "system"
				}
				out.RequestMessages = append(out.RequestMessages, ParsedMessage{
					Role:    role,
					Content: text,
				})
			}
		}
	}
	flushAssistant()
	if len(sysParts) > 0 {
		out.SystemPrompt = strings.Join(sysParts, "\n\n")
	}
}

func parseOpenAIResponsesJSON(body []byte, out *ParsedExchange) {
	var resp struct {
		ID     string `json:"id"`
		Model  string `json:"model"`
		Status string `json:"status"`
		Output []struct {
			ID        string          `json:"id"`
			Type      string          `json:"type"`
			CallID    string          `json:"call_id"`
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
			Content   json.RawMessage `json:"content"`
			Summary   json.RawMessage `json:"summary"`
		} `json:"output"`
		Usage struct {
			InputTokens        int `json:"input_tokens"`
			OutputTokens       int `json:"output_tokens"`
			InputTokensDetails struct {
				CachedTokens int `json:"cached_tokens"`
			} `json:"input_tokens_details"`
			OutputTokensDetails struct {
				ReasoningTokens int `json:"reasoning_tokens"`
			} `json:"output_tokens_details"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return
	}
	if resp.ID != "" {
		out.ResponseID = resp.ID
	}
	if resp.Model != "" {
		out.ResponseModel = resp.Model
		out.Model = resp.Model
	}
	if resp.Status != "" {
		out.FinishReason = resp.Status
	}
	var textParts, reasonParts []string
	var toolCalls []ParsedToolCall
	for _, item := range resp.Output {
		switch item.Type {
		case "message":
			if t := extractTextFromRaw(item.Content); t != "" {
				textParts = append(textParts, t)
			}
		case "reasoning":
			t := extractTextFromRaw(item.Summary)
			if t == "" {
				t = extractTextFromRaw(item.Content)
			}
			if t != "" {
				reasonParts = append(reasonParts, t)
			}
		case "function_call":
			callID := item.CallID
			if callID == "" {
				callID = item.ID
			}
			toolCalls = append(toolCalls, ParsedToolCall{
				ID:        callID,
				Name:      item.Name,
				Arguments: extractRawStringOrJSON(item.Arguments),
			})
		}
	}
	if len(textParts) > 0 {
		out.AssistantText = strings.Join(textParts, "\n")
	}
	if len(reasonParts) > 0 {
		out.ReasoningContent = strings.Join(reasonParts, "\n")
	}
	if len(toolCalls) > 0 {
		out.ToolCalls = toolCalls
	}
	if resp.Usage.InputTokens > 0 {
		out.PromptTokens = resp.Usage.InputTokens
	}
	if resp.Usage.OutputTokens > 0 {
		out.CompletionTokens = resp.Usage.OutputTokens
	}
	if resp.Usage.InputTokensDetails.CachedTokens > 0 {
		out.CachedTokens = resp.Usage.InputTokensDetails.CachedTokens
	}
	if resp.Usage.OutputTokensDetails.ReasoningTokens > 0 {
		out.ReasoningTokens = resp.Usage.OutputTokensDetails.ReasoningTokens
	}
}

type responsesFCAcc struct {
	index        int
	itemID       string
	callID       string
	name         string
	argsBuf      strings.Builder
	finalArgs    string
	hasFinalArgs bool
}

func parseOpenAIResponsesSSE(body []byte, out *ParsedExchange) {
	var textBuf strings.Builder
	var reasonBuf strings.Builder
	var doneTextParts []string
	var doneReasonParts []string
	fcByIndex := map[int]*responsesFCAcc{}
	fcByItemID := map[string]*responsesFCAcc{}

	getOrCreateFC := func(idx int, itemID string) *responsesFCAcc {
		if itemID != "" {
			if acc, ok := fcByItemID[itemID]; ok {
				return acc
			}
		}
		if acc, ok := fcByIndex[idx]; ok {
			if itemID != "" && acc.itemID == "" {
				acc.itemID = itemID
				fcByItemID[itemID] = acc
			}
			return acc
		}
		acc := &responsesFCAcc{index: idx, itemID: itemID}
		fcByIndex[idx] = acc
		if itemID != "" {
			fcByItemID[itemID] = acc
		}
		return acc
	}

	events := ParseSSEEvents(body)
	for _, ev := range events {
		payload := strings.TrimSpace(ev.Data)
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var evt struct {
			Type        string          `json:"type"`
			Delta       string          `json:"delta"`
			Text        string          `json:"text"`
			Arguments   string          `json:"arguments"`
			Name        string          `json:"name"`
			ItemID      string          `json:"item_id"`
			OutputIndex int             `json:"output_index"`
			Response    json.RawMessage `json:"response"`
			Item        *struct {
				ID        string          `json:"id"`
				Type      string          `json:"type"`
				CallID    string          `json:"call_id"`
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
				Content   json.RawMessage `json:"content"`
				Summary   json.RawMessage `json:"summary"`
			} `json:"item"`
		}
		if err := json.Unmarshal([]byte(payload), &evt); err != nil {
			continue
		}
		evType := evt.Type
		if evType == "" {
			evType = ev.Event
		}
		switch evType {
		case "response.created", "response.in_progress":
			if len(evt.Response) > 0 {
				var meta struct {
					ID     string `json:"id"`
					Model  string `json:"model"`
					Status string `json:"status"`
				}
				if err := json.Unmarshal(evt.Response, &meta); err == nil {
					if meta.ID != "" && out.ResponseID == "" {
						out.ResponseID = meta.ID
					}
					if meta.Model != "" {
						out.ResponseModel = meta.Model
						out.Model = meta.Model
					}
					if meta.Status != "" && out.FinishReason == "" {
						out.FinishReason = meta.Status
					}
				}
			}
		case "response.output_item.added":
			if evt.Item != nil && evt.Item.Type == "function_call" {
				acc := getOrCreateFC(evt.OutputIndex, evt.Item.ID)
				if evt.Item.CallID != "" {
					acc.callID = evt.Item.CallID
				}
				if evt.Item.Name != "" {
					acc.name = evt.Item.Name
				}
				if args := extractRawStringOrJSON(evt.Item.Arguments); args != "" {
					acc.argsBuf.WriteString(args)
				}
			}
		case "response.output_text.delta":
			textBuf.WriteString(evt.Delta)
		case "response.output_text.done":
			if evt.Text != "" {
				doneTextParts = append(doneTextParts, evt.Text)
			}
		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			reasonBuf.WriteString(evt.Delta)
		case "response.reasoning_summary_text.done", "response.reasoning_text.done":
			if evt.Text != "" {
				doneReasonParts = append(doneReasonParts, evt.Text)
			}
		case "response.function_call_arguments.delta":
			acc := getOrCreateFC(evt.OutputIndex, evt.ItemID)
			acc.argsBuf.WriteString(evt.Delta)
		case "response.function_call_arguments.done":
			acc := getOrCreateFC(evt.OutputIndex, evt.ItemID)
			if evt.Name != "" {
				acc.name = evt.Name
			}
			acc.finalArgs = evt.Arguments
			acc.hasFinalArgs = true
		case "response.output_item.done":
			if evt.Item != nil {
				switch evt.Item.Type {
				case "function_call":
					acc := getOrCreateFC(evt.OutputIndex, evt.Item.ID)
					if evt.Item.CallID != "" {
						acc.callID = evt.Item.CallID
					}
					if evt.Item.Name != "" {
						acc.name = evt.Item.Name
					}
					if args := extractRawStringOrJSON(evt.Item.Arguments); args != "" {
						acc.finalArgs = args
						acc.hasFinalArgs = true
					}
				case "message":
					if t := extractTextFromRaw(evt.Item.Content); t != "" {
						doneTextParts = append(doneTextParts, t)
					}
				case "reasoning":
					t := extractTextFromRaw(evt.Item.Summary)
					if t == "" {
						t = extractTextFromRaw(evt.Item.Content)
					}
					if t != "" {
						doneReasonParts = append(doneReasonParts, t)
					}
				}
			}
		case "response.completed", "response.incomplete", "response.failed":
			if len(evt.Response) > 0 {
				parseOpenAIResponsesJSON(evt.Response, out)
			}
			if out.FinishReason == "" {
				out.FinishReason = strings.TrimPrefix(evType, "response.")
			}
		}
	}
	if out.AssistantText == "" {
		if textBuf.Len() > 0 {
			out.AssistantText = textBuf.String()
		} else if len(doneTextParts) > 0 {
			out.AssistantText = strings.Join(doneTextParts, "\n")
		}
	}
	if out.ReasoningContent == "" {
		if reasonBuf.Len() > 0 {
			out.ReasoningContent = reasonBuf.String()
		} else if len(doneReasonParts) > 0 {
			out.ReasoningContent = strings.Join(doneReasonParts, "\n")
		}
	}
	if len(out.ToolCalls) == 0 && len(fcByIndex) > 0 {
		indices := make([]int, 0, len(fcByIndex))
		for idx := range fcByIndex {
			indices = append(indices, idx)
		}
		sort.Ints(indices)
		for _, idx := range indices {
			acc := fcByIndex[idx]
			callID := acc.callID
			if callID == "" {
				callID = acc.itemID
			}
			args := acc.argsBuf.String()
			if acc.hasFinalArgs {
				args = acc.finalArgs
			}
			out.ToolCalls = append(out.ToolCalls, ParsedToolCall{
				ID:        callID,
				Name:      acc.name,
				Arguments: args,
			})
		}
	}
}

func parseAnthropicRequest(body []byte, out *ParsedExchange) {
	var req struct {
		Model    string           `json:"model"`
		Stream   bool             `json:"stream"`
		System   json.RawMessage  `json:"system"`
		Tools    []map[string]any `json:"tools"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return
	}
	if req.Model != "" {
		out.RequestedModel = req.Model
		if out.Model == "" {
			out.Model = req.Model
		}
	}
	if req.Stream {
		out.IsStream = true
	}
	if len(req.Tools) > 0 {
		out.ToolDefinitions = req.Tools
	}
	if len(req.System) > 0 {
		sysText := extractTextFromRaw(req.System)
		if sysText != "" {
			out.SystemPrompt = sysText
			out.RequestMessages = append(out.RequestMessages, ParsedMessage{
				Role:    "system",
				Content: sysText,
			})
		}
	}
	for _, m := range req.Messages {
		pm := ParsedMessage{Role: m.Role}
		var strContent string
		if err := json.Unmarshal(m.Content, &strContent); err == nil {
			pm.Content = strContent
			out.RequestMessages = append(out.RequestMessages, pm)
			continue
		}
		var blocks []struct {
			Type      string          `json:"type"`
			Text      string          `json:"text"`
			Thinking  string          `json:"thinking"`
			ID        string          `json:"id"`
			Name      string          `json:"name"`
			Input     json.RawMessage `json:"input"`
			ToolUseID string          `json:"tool_use_id"`
			Content   json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(m.Content, &blocks); err == nil {
			var textParts, thinkParts []string
			for _, b := range blocks {
				switch b.Type {
				case "text":
					if b.Text != "" {
						textParts = append(textParts, b.Text)
					}
				case "thinking":
					if b.Thinking != "" {
						thinkParts = append(thinkParts, b.Thinking)
					}
				case "tool_use":
					pm.ToolCalls = append(pm.ToolCalls, ParsedToolCall{
						ID:        b.ID,
						Name:      b.Name,
						Arguments: string(b.Input),
					})
				case "tool_result":
					pm.ToolResults = append(pm.ToolResults, ParsedToolResult{
						ToolCallID: b.ToolUseID,
						Content:    extractTextFromRaw(b.Content),
					})
				}
			}
			pm.Content = strings.Join(textParts, "\n")
			pm.Reasoning = strings.Join(thinkParts, "\n")
		}
		out.RequestMessages = append(out.RequestMessages, pm)
	}
}

func parseAnthropicJSON(body []byte, out *ParsedExchange) {
	var resp struct {
		ID         string `json:"id"`
		Model      string `json:"model"`
		StopReason string `json:"stop_reason"`
		Content    []struct {
			Type     string          `json:"type"`
			Text     string          `json:"text"`
			Thinking string          `json:"thinking"`
			ID       string          `json:"id"`
			Name     string          `json:"name"`
			Input    json.RawMessage `json:"input"`
		} `json:"content"`
		Usage struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return
	}
	if resp.ID != "" {
		out.ResponseID = resp.ID
	}
	if resp.Model != "" {
		out.ResponseModel = resp.Model
		out.Model = resp.Model
	}
	out.FinishReason = resp.StopReason
	var textParts, thinkParts []string
	for _, b := range resp.Content {
		switch b.Type {
		case "text":
			if b.Text != "" {
				textParts = append(textParts, b.Text)
			}
		case "thinking":
			if b.Thinking != "" {
				thinkParts = append(thinkParts, b.Thinking)
			}
		case "tool_use":
			out.ToolCalls = append(out.ToolCalls, ParsedToolCall{
				ID:        b.ID,
				Name:      b.Name,
				Arguments: string(b.Input),
			})
		}
	}
	out.AssistantText = strings.Join(textParts, "\n")
	out.ReasoningContent = strings.Join(thinkParts, "\n")
	out.PromptTokens = resp.Usage.InputTokens + resp.Usage.CacheReadInputTokens + resp.Usage.CacheCreationInputTokens
	out.CompletionTokens = resp.Usage.OutputTokens
	out.CachedTokens = resp.Usage.CacheReadInputTokens
	out.CacheCreateTokens = resp.Usage.CacheCreationInputTokens
}

func parseAnthropicSSE(body []byte, out *ParsedExchange) {
	var textBuf strings.Builder
	var thinkBuf strings.Builder
	type blockAcc struct {
		kind  string
		id    string
		name  string
		input strings.Builder
	}
	blocks := map[int]*blockAcc{}
	var baseInput, cacheRead, cacheCreate int

	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		var evt struct {
			Type    string `json:"type"`
			Index   int    `json:"index"`
			Message *struct {
				ID    string `json:"id"`
				Model string `json:"model"`
				Usage struct {
					InputTokens              int `json:"input_tokens"`
					OutputTokens             int `json:"output_tokens"`
					CacheReadInputTokens     int `json:"cache_read_input_tokens"`
					CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
				} `json:"usage"`
			} `json:"message"`
			ContentBlock *struct {
				Type     string          `json:"type"`
				ID       string          `json:"id"`
				Name     string          `json:"name"`
				Text     string          `json:"text"`
				Thinking string          `json:"thinking"`
				Input    json.RawMessage `json:"input"`
			} `json:"content_block"`
			Delta *struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				Thinking    string `json:"thinking"`
				PartialJSON string `json:"partial_json"`
				StopReason  string `json:"stop_reason"`
			} `json:"delta"`
			Usage *struct {
				InputTokens              int `json:"input_tokens"`
				OutputTokens             int `json:"output_tokens"`
				CacheReadInputTokens     int `json:"cache_read_input_tokens"`
				CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(payload), &evt); err != nil {
			continue
		}
		switch evt.Type {
		case "message_start":
			if evt.Message != nil {
				if evt.Message.ID != "" {
					out.ResponseID = evt.Message.ID
				}
				if evt.Message.Model != "" {
					out.ResponseModel = evt.Message.Model
					out.Model = evt.Message.Model
				}
				baseInput = evt.Message.Usage.InputTokens
				cacheRead = evt.Message.Usage.CacheReadInputTokens
				cacheCreate = evt.Message.Usage.CacheCreationInputTokens
				if evt.Message.Usage.OutputTokens > 0 {
					out.CompletionTokens = evt.Message.Usage.OutputTokens
				}
			}
		case "content_block_start":
			if evt.ContentBlock != nil {
				b := &blockAcc{
					kind: evt.ContentBlock.Type,
					id:   evt.ContentBlock.ID,
					name: evt.ContentBlock.Name,
				}
				if evt.ContentBlock.Text != "" {
					textBuf.WriteString(evt.ContentBlock.Text)
				}
				if evt.ContentBlock.Thinking != "" {
					thinkBuf.WriteString(evt.ContentBlock.Thinking)
				}
				if len(evt.ContentBlock.Input) > 0 && string(evt.ContentBlock.Input) != "{}" {
					b.input.Write(evt.ContentBlock.Input)
				}
				blocks[evt.Index] = b
			}
		case "content_block_delta":
			if evt.Delta != nil {
				switch evt.Delta.Type {
				case "text_delta":
					textBuf.WriteString(evt.Delta.Text)
				case "thinking_delta":
					thinkBuf.WriteString(evt.Delta.Thinking)
				case "input_json_delta":
					if b, ok := blocks[evt.Index]; ok {
						b.input.WriteString(evt.Delta.PartialJSON)
					}
				}
			}
		case "message_delta":
			if evt.Delta != nil && evt.Delta.StopReason != "" {
				out.FinishReason = evt.Delta.StopReason
			}
			if evt.Usage != nil {
				if evt.Usage.OutputTokens > 0 {
					out.CompletionTokens = evt.Usage.OutputTokens
				}
				if evt.Usage.InputTokens > 0 {
					baseInput = evt.Usage.InputTokens
				}
				if evt.Usage.CacheReadInputTokens > 0 {
					cacheRead = evt.Usage.CacheReadInputTokens
				}
				if evt.Usage.CacheCreationInputTokens > 0 {
					cacheCreate = evt.Usage.CacheCreationInputTokens
				}
			}
		}
	}
	out.AssistantText = textBuf.String()
	out.ReasoningContent = thinkBuf.String()
	out.PromptTokens = baseInput + cacheRead + cacheCreate
	out.CachedTokens = cacheRead
	out.CacheCreateTokens = cacheCreate

	if len(blocks) > 0 {
		indices := make([]int, 0, len(blocks))
		for idx := range blocks {
			indices = append(indices, idx)
		}
		sort.Ints(indices)
		for _, idx := range indices {
			b := blocks[idx]
			if b.kind == "tool_use" {
				args := b.input.String()
				if args == "" {
					args = "{}"
				}
				out.ToolCalls = append(out.ToolCalls, ParsedToolCall{
					ID:        b.id,
					Name:      b.name,
					Arguments: args,
				})
			}
		}
	}
}

func ExtractToolsFromRequest(headers http.Header, body []byte) []map[string]any {
	if len(body) == 0 {
		return nil
	}
	plain := DecompressIfGzip(headers, body)
	var req struct {
		Tools []map[string]any `json:"tools"`
	}
	if err := json.Unmarshal(plain, &req); err != nil {
		return nil
	}
	return normalizeToolDefinitions(req.Tools)
}

func ExtractRequestModel(headers http.Header, body []byte) string {
	if len(body) == 0 {
		return ""
	}
	plain := DecompressIfGzip(headers, body)
	var req struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(plain, &req); err != nil {
		return ""
	}
	return req.Model
}

func ExtractResponseMetadata(headers http.Header, body []byte) ResponseMetadata {
	var meta ResponseMetadata
	if len(body) == 0 {
		return meta
	}
	plain := DecompressIfGzip(headers, body)
	ct := ""
	if headers != nil {
		ct = strings.ToLower(headers.Get("Content-Type"))
	}
	isSSE := strings.Contains(ct, "text/event-stream") || LooksLikeSSE(plain)
	meta.IsStream = isSSE
	if isSSE {
		merged := BuildMergedSSEResponse(plain, headers)
		if merged != nil {
			if v, ok := merged["model"].(string); ok {
				meta.ResponseModel = v
			}
			if v, ok := merged["id"].(string); ok {
				meta.ResponseID = v
			}
			if v, ok := merged["finish_reason"].(string); ok {
				meta.FinishReason = v
			}
		}
		return meta
	}
	var resp struct {
		ID         string `json:"id"`
		Model      string `json:"model"`
		StopReason string `json:"stop_reason"`
		Status     string `json:"status"`
		Choices    []struct {
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(plain, &resp); err == nil {
		meta.ResponseID = resp.ID
		meta.ResponseModel = resp.Model
		if len(resp.Choices) > 0 && resp.Choices[0].FinishReason != "" {
			meta.FinishReason = resp.Choices[0].FinishReason
		} else if resp.StopReason != "" {
			meta.FinishReason = resp.StopReason
		} else if resp.Status != "" {
			meta.FinishReason = resp.Status
		}
	}
	return meta
}

func ParseSSEEvents(rawBody []byte) []SSEEvent {
	plain := DecompressIfGzip(nil, rawBody)
	events := make([]SSEEvent, 0)
	scanner := bufio.NewScanner(bytes.NewReader(plain))
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)

	var currentEvent string
	var dataLines []string
	idx := 0

	flush := func() {
		if len(dataLines) == 0 && currentEvent == "" {
			return
		}
		idx++
		events = append(events, SSEEvent{
			Index: idx,
			Event: currentEvent,
			Data:  strings.Join(dataLines, "\n"),
		})
		currentEvent = ""
		dataLines = nil
	}

	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		if strings.HasPrefix(line, "event:") {
			currentEvent = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			continue
		}
		if strings.HasPrefix(line, "data:") {
			val := strings.TrimPrefix(line, "data:")
			if strings.HasPrefix(val, " ") {
				val = val[1:]
			}
			dataLines = append(dataLines, val)
		}
	}
	flush()
	return events
}

func BuildMergedSSEResponse(rawBody []byte, headers map[string][]string) map[string]any {
	var hdr http.Header
	if headers != nil {
		hdr = http.Header(headers)
	}
	plain := DecompressIfGzip(hdr, rawBody)
	events := ParseSSEEvents(plain)
	if len(events) == 0 {
		return nil
	}

	var id, model, object, role, status, finishReason string
	var contentBuf strings.Builder
	var reasoningBuf strings.Builder
	var doneContentParts []string
	var doneReasonParts []string
	var usage map[string]any
	var hasValidJSON bool

	type tcAcc struct {
		id     string
		tcType string
		name   string
		args   strings.Builder
	}
	tcMap := map[int]*tcAcc{}
	anthropicBlocks := map[int]*tcAcc{}
	anthropicUsage := map[string]any{}
	var responsesToolCalls []map[string]any
	var responsesOutput []any
	respFCByIndex := map[int]*responsesFCAcc{}
	respFCByItemID := map[string]*responsesFCAcc{}

	getOrCreateRespFC := func(idx int, itemID string) *responsesFCAcc {
		if itemID != "" {
			if acc, ok := respFCByItemID[itemID]; ok {
				return acc
			}
		}
		if acc, ok := respFCByIndex[idx]; ok {
			if itemID != "" && acc.itemID == "" {
				acc.itemID = itemID
				respFCByItemID[itemID] = acc
			}
			return acc
		}
		acc := &responsesFCAcc{index: idx, itemID: itemID}
		respFCByIndex[idx] = acc
		if itemID != "" {
			respFCByItemID[itemID] = acc
		}
		return acc
	}

	for _, ev := range events {
		payload := strings.TrimSpace(ev.Data)
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var rawMap map[string]any
		if err := json.Unmarshal([]byte(payload), &rawMap); err != nil {
			continue
		}
		hasValidJSON = true

		evType, _ := rawMap["type"].(string)

		if _, hasChoices := rawMap["choices"]; hasChoices || strings.HasPrefix(strField(rawMap, "object"), "chat.completion") {
			if object == "" {
				obj := strField(rawMap, "object")
				if obj == "chat.completion.chunk" || obj == "" {
					object = "chat.completion"
				} else {
					object = obj
				}
			}
			if v := strField(rawMap, "id"); v != "" && id == "" {
				id = v
			}
			if v := strField(rawMap, "model"); v != "" {
				model = v
			}
			if u, ok := rawMap["usage"].(map[string]any); ok && len(u) > 0 {
				usage = u
			}
			var chunk struct {
				Choices []struct {
					FinishReason string `json:"finish_reason"`
					Delta        struct {
						Role             string `json:"role"`
						Content          string `json:"content"`
						ReasoningContent string `json:"reasoning_content"`
						Reasoning        string `json:"reasoning"`
						ToolCalls        []struct {
							Index    int    `json:"index"`
							ID       string `json:"id"`
							Type     string `json:"type"`
							Function struct {
								Name      string `json:"name"`
								Arguments string `json:"arguments"`
							} `json:"function"`
						} `json:"tool_calls"`
					} `json:"delta"`
				} `json:"choices"`
			}
			if err := json.Unmarshal([]byte(payload), &chunk); err == nil && len(chunk.Choices) > 0 {
				c := chunk.Choices[0]
				if c.Delta.Role != "" && role == "" {
					role = c.Delta.Role
				}
				if c.FinishReason != "" {
					finishReason = c.FinishReason
				}
				if c.Delta.Content != "" {
					contentBuf.WriteString(c.Delta.Content)
				}
				if c.Delta.ReasoningContent != "" {
					reasoningBuf.WriteString(c.Delta.ReasoningContent)
				} else if c.Delta.Reasoning != "" {
					reasoningBuf.WriteString(c.Delta.Reasoning)
				}
				for _, tc := range c.Delta.ToolCalls {
					acc, ok := tcMap[tc.Index]
					if !ok {
						acc = &tcAcc{tcType: "function"}
						tcMap[tc.Index] = acc
					}
					if tc.ID != "" {
						acc.id = tc.ID
					}
					if tc.Type != "" {
						acc.tcType = tc.Type
					}
					if tc.Function.Name != "" {
						acc.name = tc.Function.Name
					}
					if tc.Function.Arguments != "" {
						acc.args.WriteString(tc.Function.Arguments)
					}
				}
			}
			continue
		}

		if evType == "message_start" || evType == "content_block_start" || evType == "content_block_delta" || evType == "message_delta" || evType == "message_stop" {
			if object == "" {
				object = "message"
			}
			var aEvt struct {
				Type    string `json:"type"`
				Index   int    `json:"index"`
				Message *struct {
					ID    string         `json:"id"`
					Model string         `json:"model"`
					Role  string         `json:"role"`
					Usage map[string]any `json:"usage"`
				} `json:"message"`
				ContentBlock *struct {
					Type     string          `json:"type"`
					ID       string          `json:"id"`
					Name     string          `json:"name"`
					Text     string          `json:"text"`
					Thinking string          `json:"thinking"`
					Input    json.RawMessage `json:"input"`
				} `json:"content_block"`
				Delta *struct {
					Type        string `json:"type"`
					Text        string `json:"text"`
					Thinking    string `json:"thinking"`
					PartialJSON string `json:"partial_json"`
					StopReason  string `json:"stop_reason"`
				} `json:"delta"`
				Usage map[string]any `json:"usage"`
			}
			if err := json.Unmarshal([]byte(payload), &aEvt); err == nil {
				switch aEvt.Type {
				case "message_start":
					if aEvt.Message != nil {
						if aEvt.Message.ID != "" {
							id = aEvt.Message.ID
						}
						if aEvt.Message.Model != "" {
							model = aEvt.Message.Model
						}
						if aEvt.Message.Role != "" {
							role = aEvt.Message.Role
						}
						for k, v := range aEvt.Message.Usage {
							anthropicUsage[k] = v
						}
					}
				case "content_block_start":
					if aEvt.ContentBlock != nil {
						if aEvt.ContentBlock.Text != "" {
							contentBuf.WriteString(aEvt.ContentBlock.Text)
						}
						if aEvt.ContentBlock.Thinking != "" {
							reasoningBuf.WriteString(aEvt.ContentBlock.Thinking)
						}
						if aEvt.ContentBlock.Type == "tool_use" {
							acc := &tcAcc{
								id:     aEvt.ContentBlock.ID,
								tcType: "function",
								name:   aEvt.ContentBlock.Name,
							}
							if len(aEvt.ContentBlock.Input) > 0 && string(aEvt.ContentBlock.Input) != "{}" {
								acc.args.Write(aEvt.ContentBlock.Input)
							}
							anthropicBlocks[aEvt.Index] = acc
						}
					}
				case "content_block_delta":
					if aEvt.Delta != nil {
						switch aEvt.Delta.Type {
						case "text_delta":
							contentBuf.WriteString(aEvt.Delta.Text)
						case "thinking_delta":
							reasoningBuf.WriteString(aEvt.Delta.Thinking)
						case "input_json_delta":
							if acc, ok := anthropicBlocks[aEvt.Index]; ok {
								acc.args.WriteString(aEvt.Delta.PartialJSON)
							}
						}
					}
				case "message_delta":
					if aEvt.Delta != nil && aEvt.Delta.StopReason != "" {
						finishReason = aEvt.Delta.StopReason
					}
					for k, v := range aEvt.Usage {
						anthropicUsage[k] = v
					}
				}
			}
			continue
		}

		if strings.HasPrefix(evType, "response.") || strings.HasPrefix(ev.Event, "response.") {
			if object == "" {
				object = "response"
			}
			if evType == "" {
				evType = ev.Event
			}
			var rEvt struct {
				Type        string          `json:"type"`
				Delta       string          `json:"delta"`
				Text        string          `json:"text"`
				Arguments   string          `json:"arguments"`
				Name        string          `json:"name"`
				ItemID      string          `json:"item_id"`
				OutputIndex int             `json:"output_index"`
				Response    json.RawMessage `json:"response"`
				Item        *struct {
					ID        string          `json:"id"`
					Type      string          `json:"type"`
					CallID    string          `json:"call_id"`
					Name      string          `json:"name"`
					Arguments json.RawMessage `json:"arguments"`
					Content   json.RawMessage `json:"content"`
					Summary   json.RawMessage `json:"summary"`
				} `json:"item"`
			}
			if err := json.Unmarshal([]byte(payload), &rEvt); err == nil {
				switch evType {
				case "response.created", "response.in_progress":
					if len(rEvt.Response) > 0 {
						var meta struct {
							ID     string `json:"id"`
							Model  string `json:"model"`
							Status string `json:"status"`
						}
						if err := json.Unmarshal(rEvt.Response, &meta); err == nil {
							if meta.ID != "" && id == "" {
								id = meta.ID
							}
							if meta.Model != "" {
								model = meta.Model
							}
							if meta.Status != "" && status == "" {
								status = meta.Status
							}
						}
					}
				case "response.output_item.added":
					if rEvt.Item != nil && rEvt.Item.Type == "function_call" {
						acc := getOrCreateRespFC(rEvt.OutputIndex, rEvt.Item.ID)
						if rEvt.Item.CallID != "" {
							acc.callID = rEvt.Item.CallID
						}
						if rEvt.Item.Name != "" {
							acc.name = rEvt.Item.Name
						}
						if args := extractRawStringOrJSON(rEvt.Item.Arguments); args != "" {
							acc.argsBuf.WriteString(args)
						}
					}
				case "response.output_text.delta":
					contentBuf.WriteString(rEvt.Delta)
				case "response.output_text.done":
					if rEvt.Text != "" {
						doneContentParts = append(doneContentParts, rEvt.Text)
					}
				case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
					reasoningBuf.WriteString(rEvt.Delta)
				case "response.reasoning_summary_text.done", "response.reasoning_text.done":
					if rEvt.Text != "" {
						doneReasonParts = append(doneReasonParts, rEvt.Text)
					}
				case "response.function_call_arguments.delta":
					acc := getOrCreateRespFC(rEvt.OutputIndex, rEvt.ItemID)
					acc.argsBuf.WriteString(rEvt.Delta)
				case "response.function_call_arguments.done":
					acc := getOrCreateRespFC(rEvt.OutputIndex, rEvt.ItemID)
					if rEvt.Name != "" {
						acc.name = rEvt.Name
					}
					acc.finalArgs = rEvt.Arguments
					acc.hasFinalArgs = true
				case "response.output_item.done":
					if rEvt.Item != nil {
						switch rEvt.Item.Type {
						case "function_call":
							acc := getOrCreateRespFC(rEvt.OutputIndex, rEvt.Item.ID)
							if rEvt.Item.CallID != "" {
								acc.callID = rEvt.Item.CallID
							}
							if rEvt.Item.Name != "" {
								acc.name = rEvt.Item.Name
							}
							if args := extractRawStringOrJSON(rEvt.Item.Arguments); args != "" {
								acc.finalArgs = args
								acc.hasFinalArgs = true
							}
						case "message":
							if t := extractTextFromRaw(rEvt.Item.Content); t != "" {
								doneContentParts = append(doneContentParts, t)
							}
						case "reasoning":
							t := extractTextFromRaw(rEvt.Item.Summary)
							if t == "" {
								t = extractTextFromRaw(rEvt.Item.Content)
							}
							if t != "" {
								doneReasonParts = append(doneReasonParts, t)
							}
						}
					}
				case "response.completed", "response.incomplete", "response.failed":
					if len(rEvt.Response) > 0 {
						var respObj struct {
							ID     string         `json:"id"`
							Model  string         `json:"model"`
							Status string         `json:"status"`
							Usage  map[string]any `json:"usage"`
							Output []struct {
								ID        string          `json:"id"`
								Type      string          `json:"type"`
								CallID    string          `json:"call_id"`
								Name      string          `json:"name"`
								Arguments json.RawMessage `json:"arguments"`
								Content   json.RawMessage `json:"content"`
								Summary   json.RawMessage `json:"summary"`
							} `json:"output"`
						}
						var rawRespMap map[string]any
						if err := json.Unmarshal(rEvt.Response, &rawRespMap); err == nil {
							if outArr, ok := rawRespMap["output"].([]any); ok && len(outArr) > 0 {
								responsesOutput = outArr
							}
						}
						if err := json.Unmarshal(rEvt.Response, &respObj); err == nil {
							if respObj.ID != "" {
								id = respObj.ID
							}
							if respObj.Model != "" {
								model = respObj.Model
							}
							if respObj.Status != "" {
								status = respObj.Status
								finishReason = respObj.Status
							}
							if len(respObj.Usage) > 0 {
								usage = respObj.Usage
							}
							var txtParts, rsnParts []string
							var completedTCs []map[string]any
							for _, item := range respObj.Output {
								switch item.Type {
								case "message":
									if t := extractTextFromRaw(item.Content); t != "" {
										txtParts = append(txtParts, t)
									}
								case "reasoning":
									t := extractTextFromRaw(item.Summary)
									if t == "" {
										t = extractTextFromRaw(item.Content)
									}
									if t != "" {
										rsnParts = append(rsnParts, t)
									}
								case "function_call":
									callID := item.CallID
									if callID == "" {
										callID = item.ID
									}
									completedTCs = append(completedTCs, map[string]any{
										"id":   callID,
										"type": "function",
										"function": map[string]any{
											"name":      item.Name,
											"arguments": extractRawStringOrJSON(item.Arguments),
										},
									})
								}
							}
							if len(completedTCs) > 0 {
								responsesToolCalls = completedTCs
							}
							if contentBuf.Len() == 0 && len(txtParts) > 0 {
								contentBuf.WriteString(strings.Join(txtParts, "\n"))
							}
							if reasoningBuf.Len() == 0 && len(rsnParts) > 0 {
								reasoningBuf.WriteString(strings.Join(rsnParts, "\n"))
							}
						}
					}
					if status == "" {
						status = strings.TrimPrefix(evType, "response.")
					}
					if finishReason == "" {
						finishReason = status
					}
				}
			}
			continue
		}
	}

	if !hasValidJSON {
		return nil
	}
	if role == "" {
		role = "assistant"
	}
	if usage == nil && len(anthropicUsage) > 0 {
		usage = anthropicUsage
	}
	if contentBuf.Len() == 0 && len(doneContentParts) > 0 {
		contentBuf.WriteString(strings.Join(doneContentParts, "\n"))
	}
	if reasoningBuf.Len() == 0 && len(doneReasonParts) > 0 {
		reasoningBuf.WriteString(strings.Join(doneReasonParts, "\n"))
	}

	toolCalls := make([]map[string]any, 0)
	if len(tcMap) > 0 {
		indices := make([]int, 0, len(tcMap))
		for idx := range tcMap {
			indices = append(indices, idx)
		}
		sort.Ints(indices)
		for _, idx := range indices {
			acc := tcMap[idx]
			toolCalls = append(toolCalls, map[string]any{
				"id":   acc.id,
				"type": acc.tcType,
				"function": map[string]any{
					"name":      acc.name,
					"arguments": acc.args.String(),
				},
			})
		}
	}
	if len(anthropicBlocks) > 0 {
		indices := make([]int, 0, len(anthropicBlocks))
		for idx := range anthropicBlocks {
			indices = append(indices, idx)
		}
		sort.Ints(indices)
		for _, idx := range indices {
			acc := anthropicBlocks[idx]
			args := acc.args.String()
			if args == "" {
				args = "{}"
			}
			toolCalls = append(toolCalls, map[string]any{
				"id":   acc.id,
				"type": acc.tcType,
				"function": map[string]any{
					"name":      acc.name,
					"arguments": args,
				},
			})
		}
	}
	if len(responsesToolCalls) > 0 {
		toolCalls = append(toolCalls, responsesToolCalls...)
	} else if len(respFCByIndex) > 0 {
		indices := make([]int, 0, len(respFCByIndex))
		for idx := range respFCByIndex {
			indices = append(indices, idx)
		}
		sort.Ints(indices)
		for _, idx := range indices {
			acc := respFCByIndex[idx]
			callID := acc.callID
			if callID == "" {
				callID = acc.itemID
			}
			args := acc.argsBuf.String()
			if acc.hasFinalArgs {
				args = acc.finalArgs
			}
			toolCalls = append(toolCalls, map[string]any{
				"id":   callID,
				"type": "function",
				"function": map[string]any{
					"name":      acc.name,
					"arguments": args,
				},
			})
		}
	}

	merged := map[string]any{
		"id":      id,
		"model":   model,
		"object":  object,
		"role":    role,
		"content": contentBuf.String(),
	}
	if object == "response" {
		if status != "" {
			merged["status"] = status
		} else if finishReason != "" {
			merged["status"] = finishReason
		}
		if len(responsesOutput) > 0 {
			merged["output"] = responsesOutput
		} else {
			synthOutput := make([]any, 0)
			if reasoningBuf.Len() > 0 {
				synthOutput = append(synthOutput, map[string]any{
					"type": "reasoning",
					"summary": []map[string]any{
						{"type": "summary_text", "text": reasoningBuf.String()},
					},
				})
			}
			if contentBuf.Len() > 0 {
				synthOutput = append(synthOutput, map[string]any{
					"type": "message",
					"role": "assistant",
					"content": []map[string]any{
						{"type": "output_text", "text": contentBuf.String()},
					},
				})
			}
			for _, tc := range toolCalls {
				fn, _ := tc["function"].(map[string]any)
				synthOutput = append(synthOutput, map[string]any{
					"type":      "function_call",
					"call_id":   tc["id"],
					"name":      fn["name"],
					"arguments": fn["arguments"],
				})
			}
			if len(synthOutput) > 0 {
				merged["output"] = synthOutput
			}
		}
	}
	if reasoningBuf.Len() > 0 {
		merged["reasoning_content"] = reasoningBuf.String()
	}
	if len(toolCalls) > 0 {
		merged["tool_calls"] = toolCalls
	}
	if finishReason != "" {
		merged["finish_reason"] = finishReason
	}
	if len(usage) > 0 {
		merged["usage"] = usage
	}
	return merged
}

func strField(m map[string]any, key string) string {
	v, _ := m[key].(string)
	return v
}

func setExchangeMeta(out *ParsedExchange, key string, val any) {
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	out.Metadata[key] = val
}

func normalizeToolDefinitions(tools []map[string]any) []map[string]any {
	if len(tools) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		if t == nil {
			continue
		}
		norm := make(map[string]any, len(t)+1)
		for k, v := range t {
			norm[k] = v
		}
		tType, _ := norm["type"].(string)
		if tType != "" && tType != "function" {
			if name, _ := norm["name"].(string); name == "" {
				norm["name"] = tType
			}
		}
		out = append(out, norm)
	}
	return out
}

func extractRawStringOrJSON(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	var s string
	if err := json.Unmarshal(trimmed, &s); err == nil {
		return s
	}
	return string(trimmed)
}

func extractOutputFromRaw(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	var s string
	if err := json.Unmarshal(trimmed, &s); err == nil {
		return s
	}
	var arr []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(trimmed, &arr); err == nil && len(arr) > 0 {
		var parts []string
		for _, item := range arr {
			if item.Text != "" {
				parts = append(parts, item.Text)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
	}
	return string(trimmed)
}

func extractTextFromRaw(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var arr []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &arr); err == nil {
		var parts []string
		hasImage := false
		for _, item := range arr {
			if item.Text != "" {
				parts = append(parts, item.Text)
			} else if item.Type == "input_image" || item.Type == "image_url" || item.Type == "image" {
				hasImage = true
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
		if hasImage {
			return "[image]"
		}
		return ""
	}
	return ""
}
