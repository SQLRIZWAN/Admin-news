# Category configuration for automated news video pipeline

CATEGORIES = {
    'kuwait': {
        'label': '🇰🇼 Kuwait',
        'color': '#34d399',
        'voice': 'en-US-GuyNeural',
        'search_keyword': 'Kuwait news',
        'rss_feeds': [
            'https://www.kuwaittimes.com/feed/',
            'https://www.arabtimesonline.com/feed/',
            'https://kuna.net.kw/rss.aspx',
        ],
        'gemini_focus': (
            'Find the most important news from Kuwait today. '
            'Focus on local events, government decisions, economy, or breaking news.'
        ),
    },
    'world': {
        'label': '🌍 World',
        'color': '#60a5fa',
        'voice': 'en-US-GuyNeural',
        'search_keyword': 'world news today',
        'rss_feeds': [
            'https://feeds.bbci.co.uk/news/world/rss.xml',
            'https://www.aljazeera.com/xml/rss/all.xml',
            'https://feeds.reuters.com/reuters/worldnews',
        ],
        'gemini_focus': (
            'Find the most significant world news event happening right now. '
            'Cover major geopolitical, economic, or humanitarian events.'
        ),
    },
    'kuwait-jobs': {
        'label': '💼 Kuwait Jobs',
        'color': '#a78bfa',
        'voice': 'en-US-AriaNeural',
        'search_keyword': 'Kuwait job vacancy',
        'rss_feeds': [
            'https://www.bayt.com/en/rss/jobs/in-kuwait/',
            'https://www.gulftalent.com/rss/jobs/kuwait',
        ],
        'gemini_focus': (
            'Find a specific job vacancy posted in Kuwait. '
            'Include company name, job title, requirements, salary if available, '
            'and the direct apply link. Source from Bayt.com, LinkedIn, or GulfTalent.'
        ),
    },
    'kuwait-offers': {
        'label': '🛍️ Kuwait Offers',
        'color': '#f472b6',
        'voice': 'en-US-AriaNeural',
        'search_keyword': 'Kuwait offer deal today',
        'rss_feeds': [],   # No dedicated RSS — uses Gemini search
        'gemini_focus': (
            'Find a supermarket or mall offer/deal available in Kuwait today. '
            'Include store name, product, price, discount, validity date, and buy link.'
        ),
    },
    'funny-news-meme': {
        'label': '😂 Funny & Memes',
        'color': '#fbbf24',
        'voice': 'en-US-GuyNeural',
        'search_keyword': 'funny viral news',
        'rss_feeds': [
            'https://www.reddit.com/r/funny.rss',
            'https://www.theonion.com/rss',
        ],
        'gemini_focus': (
            'Find the most viral or funny news story, meme, or humorous event '
            'trending in Kuwait or the Arab world today.'
        ),
    },
}
