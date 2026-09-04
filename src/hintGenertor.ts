import axios from 'axios';
import * as vscode from 'vscode';
import { ExerciseContext } from './contextCollector';
import { classifyByRule, shouldUseLLMClassifier, buildClassificationPrompt, parseLLMResponse, KeywordClassification } from './hintClassifier';
import { buildHintPrompt } from './promptLibrary';

export interface LLMConfig {
    apiUrl: string;
    apiKey: string;
    modelName: string;
}

export async function classifyHintType(
    exerciseContext: ExerciseContext,
    config: LLMConfig
): Promise<KeywordClassification> {
    const ruleClassification = classifyByRule(exerciseContext);
    if (!shouldUseLLMClassifier(ruleClassification)) {
        return ruleClassification;
    }
    return await getLLMClassification(exerciseContext, ruleClassification, config);
}

export async function generateHint(
    exerciseContext: ExerciseContext,
    config: LLMConfig,
    _extensionContext: vscode.ExtensionContext
): Promise<string> {
    const finalClassification = await classifyHintType(exerciseContext, config);
    const prompt = buildHintPrompt(exerciseContext, finalClassification);
    return await callLLMAPI(prompt, config);
}

export async function callLLMAPI (
    prompt: string,
    config: LLMConfig
): Promise<string> {
    const isOpenAIEndpoint = config.apiUrl.includes('/chat/completions');
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    if (config.apiKey && config.apiKey.trim()) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    console.log('[LLM API] URL: ', config.apiUrl);
    console.log('[LLM API] Model: ', config.modelName);
    console.log('[LLM API] API key exists: ', Boolean(config.apiKey));
    console.log('[LLM API]: Authorization sent: ', Boolean(headers.Authorization));

    const body = isOpenAIEndpoint ? {
        model: config.modelName,
        messages: [
            {
                role: 'user',
                content: prompt,
            },
        ],
        max_tokens: 220,
    } : {
        model: config.modelName,
        prompt: prompt,
        stream: false,
    };

    try {
        const response = await axios.post(config.apiUrl, body, {headers});

        if (isOpenAIEndpoint) {
            const content = response.data?.choices?.[0]?.message?.content;

            if (!content) {
                throw new Error('Invalid OpenAI response format.');
            }
            return content.trim();
        }
        const content = response.data?.response;

        if (!content) {
            throw new Error('Invalid Ollama response format.');
        }
        return content.trim();
    } catch(error) {
        if (axios.isAxiosError(error)) {
            console.error("[LLM API] Request failed");
            console.error("[LLM API] Status:", error.response?.status);
            console.error("[LLM API] Response data:", error.response?.data);
            console.error("[LLM API] Request body:", error.config?.data);
            console.error("[LLM API] Request URL:", error.config?.url);
            console.error("[LLM API] Request method:", error.config?.method);
        } else {
            console.error("[LLM API] Unknwon error: ", error);
        }
        throw error;
    }
}

async function getLLMClassification(
    exerciseContext: ExerciseContext,
    ruleClassification: KeywordClassification,
    config: LLMConfig
): Promise<KeywordClassification> {
    const classifierPrompt = buildClassificationPrompt(
        exerciseContext,
    );

    try {
        const rawResponse = await callLLMAPI(classifierPrompt, config);
        const parsedClassification = parseLLMResponse(rawResponse);

        return {
            ...ruleClassification,
            category: parsedClassification.category,
        };
    } catch (error) {
        console.error("Failed to get LLM classification:", error);

        return {
            ...ruleClassification,
            category: "Unknown",
        }
    }
}