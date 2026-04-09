# Category configuration for automated news video pipeline

CATEGORIES = {
    'kuwait': {
        'label': '🇰🇼 Kuwait',
        'color': '#34d399',
        'voice': 'en-US-GuyNeural',
        'search_keyword': 'Kuwait news',
        'rss_feeds': [
            # International feeds that work from any server (GitHub Actions = US)
            'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml',  # BBC Middle East
            'https://www.aljazeera.com/xml/rss/all.xml',                # Al Jazeera
            'https://feeds.reuters.com/reuters/MENATopNews',            # Reuters MENA
            # Kuwait-direct (may be blocked from US servers — used as extras)
            'https://www.arabtimesonline.com/feed/',
            'https://www.kuwaittimes.com/feed/',
            'https://kuna.net.kw/rss.aspx',
        ],
        'gemini_focus': (
            'Find the most important news from Kuwait or the Gulf region today. '
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
            'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
            'https://feeds.bbci.co.uk/news/rss.xml',
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
            # Business/job-market news from reliable global sources
            'https://feeds.bbci.co.uk/news/business/rss.xml',         # BBC Business
            'https://feeds.reuters.com/reuters/businessNews',          # Reuters Business
            'https://www.bayt.com/en/rss/jobs/in-kuwait/',             # Bayt.com
            'https://www.gulftalent.com/rss/jobs/kuwait',              # GulfTalent
        ],
        'gemini_focus': (
            'Find a specific job vacancy posted in Kuwait or the Gulf region. '
            'Include company name, job title, requirements, salary if available, '
            'and the direct apply link. Source from Bayt.com, LinkedIn, or GulfTalent.'
        ),
    },
    'kuwait-offers': {
        'label': '🛍️ Kuwait Offers',
        'color': '#f472b6',
        'voice': 'en-US-AriaNeural',
        'search_keyword': 'Kuwait deal offer',
        'rss_feeds': [
            # Consumer/business news with deals coverage
            'https://feeds.bbci.co.uk/news/business/rss.xml',
            'https://feeds.reuters.com/reuters/businessNews',
        ],
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
            'https://www.reddit.com/r/funny/.rss',
            'https://www.reddit.com/r/worldnews/.rss',
            'https://www.theonion.com/rss',
            'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
        ],
        'gemini_focus': (
            'Find the most viral or funny news story, meme, or humorous event '
            'trending today. Lighthearted content preferred.'
        ),
    },
}
