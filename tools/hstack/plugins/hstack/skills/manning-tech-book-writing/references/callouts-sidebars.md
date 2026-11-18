# Callouts vs Sidebars

Understanding when to use callouts versus sidebars is crucial for effective technical writing at Manning.

## Callouts

### Purpose
Emphasize **essential information** that readers must not miss. This includes critical concepts, warnings, tips, definitions, and key takeaways.

### When to Use
- **Definitions** of important terms
- **Warnings** about common mistakes
- **Tips** for best practices  
- **Key concepts** that are foundational
- **Critical notes** about behavior or limitations
- **Important takeaways** (often summary bullet points)

### Format Guidelines
- **Length**: One sentence to a short paragraph
- **Style**: Use Manning's .Callout Head and .Callout styles
- **Header**: Can use "Note," "Warning," "Tip," "Definition," etc.
- **Placement**: Near the concept being emphasized

### Connection to Summary
Any takeaway in your summary bullets likely deserves a callout where you first teach that concept.

### Example Callout
```
NOTE While we cover REST in more detail in chapter 2, the core concept 
behind REST is that your services should embrace the use of HTTP verbs 
(GET, POST, PUT, and DELETE) to represent the core actions of the service 
and use a lightweight web-oriented data serialization protocol, such as JSON, 
for requesting and receiving data from the service.
```

## Sidebars

### Purpose  
Provide **non-essential, supplementary information** that adds interest but could be skipped without affecting learning.

### When to Use
- **Historical context** or evolution of technology
- **Alternative approaches** not covered in detail
- **Interesting tangents** or related topics
- **Advanced topics** beyond chapter scope
- **Real-world anecdotes** that illustrate but don't teach
- **Optional deep dives** for curious readers

### Format Guidelines
- **Length**: Can be longer than callouts
- **Style**: Use Manning sidebar styles
- **Title**: Give descriptive title
- **Placement**: Don't interrupt critical flow

### Reader Expectation
The sidebar format explicitly tells readers they can skip this content without missing anything important.

### Example Sidebar Topics
- "Why the cloud and microservices?"
- "Emerging cloud platforms" 
- "The history of REST"
- "Alternative authentication methods"

## Quick Decision Guide

Ask yourself: "If a reader skipped this, would they miss something essential?"

- **YES** → Use a **callout**
- **NO** → Use a **sidebar** (or consider omitting)

## Visual Formatting

### Callout Appearance
- Highlighted box with distinctive formatting
- Stands out from main text
- Brief and focused
- Part of the main reading flow

### Sidebar Appearance
- Separate boxed section
- Different visual style from main content
- Can be longer form
- Clearly skippable

## Common Mistakes

### Overusing Callouts
- Don't make everything a callout
- Reserve for truly important information
- If too many, readers ignore them all

### Misusing Sidebars
- Don't hide essential information in sidebars
- Don't use for required prerequisites
- Don't break critical explanations into sidebars

## Best Practices

### Callout Best Practices
1. Keep them short and focused
2. Place immediately after introducing concept
3. Use clear, direct language
4. Ensure they're truly essential
5. Connect to chapter's key takeaways

### Sidebar Best Practices
1. Make them self-contained
2. Provide clear, descriptive titles
3. Ensure main text flows without them
4. Use for enrichment, not requirements
5. Keep interesting but not essential

## Integration with Chapter Flow

### Callouts in Flow
- Part of the main narrative
- Reinforce key points
- Can't be skipped
- Support learning objectives

### Sidebars as Branches
- Optional detours
- Enhance but don't define
- Can be read out of order
- Add color and context
