"""DeepSeek API client wrapper."""
import httpx
from typing import List, Dict, Optional
from config import settings


class LLMClient:
    def __init__(self):
        self.base_url = settings.DEEPSEEK_BASE_URL.rstrip('/')
        self.api_key = settings.DEEPSEEK_API_KEY
        self.model = settings.DEEPSEEK_MODEL

    def _headers(self) -> Dict:
        return {
            'Authorization': f'Bearer {self.api_key}',
            'Content-Type': 'application/json',
        }

    def chat(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.7,
        max_tokens: int = 1000,
        response_format: Optional[str] = None,  # 'json_object' for JSON mode
    ) -> str:
        """Single non-streaming chat completion."""
        payload: Dict = {
            'model': self.model,
            'messages': messages,
            'temperature': temperature,
            'max_tokens': max_tokens,
        }
        if response_format:
            payload['response_format'] = {'type': response_format}

        with httpx.Client(timeout=60.0) as client:
            resp = client.post(
                f'{self.base_url}/chat/completions',
                headers=self._headers(),
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

        text = data['choices'][0]['message']['content'].strip()
        return text

    def chat_json(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.5,
        max_tokens: int = 1500,
    ) -> str:
        """Force JSON output. Returns raw JSON string (caller parses)."""
        return self.chat(
            messages=messages,
            temperature=temperature,
            response_format='json_object',
            max_tokens=max_tokens,
        )


llm = LLMClient()
