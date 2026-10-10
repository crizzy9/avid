#import <AppKit/AppKit.h>
#import <CoreSpotlight/CoreSpotlight.h>
#import <Foundation/Foundation.h>
#import <objc/runtime.h>

// Keep Tao's handling of web activities intact. Avid owns only its Spotlight IDs.
static void (*avidNavigate)(const char *) = NULL;
static IMP previousWillContinue = NULL;
static IMP previousContinue = NULL;
static BOOL avidWillContinue(id self, SEL selector, NSApplication *application, NSString *type) {
    if ([type isEqualToString:CSSearchableItemActionType]) return YES;
    return previousWillContinue ? ((BOOL (*)(id, SEL, NSApplication *, NSString *))previousWillContinue)(self, selector, application, type) : NO;
}
static BOOL avidContinue(id self, SEL selector, NSApplication *application, NSUserActivity *activity, id restoration) {
    if ([activity.activityType isEqualToString:CSSearchableItemActionType]) {
        id identifier = activity.userInfo[CSSearchableItemActivityIdentifier];
        if ([identifier isKindOfClass:NSString.class] && [identifier hasPrefix:@"avid.book."] && [identifier length] <= 100 && avidNavigate) {
            avidNavigate([identifier UTF8String]);
            return YES;
        }
    }
    return previousContinue ? ((BOOL (*)(id, SEL, NSApplication *, NSUserActivity *, id))previousContinue)(self, selector, application, activity, restoration) : NO;
}
bool avid_spotlight_initialize(void (*navigate)(const char *)) {
    if (![CSSearchableIndex isIndexingAvailable] || !NSApp.delegate) return false;
    Class cls = [NSApp.delegate class];
    SEL will = @selector(application:willContinueUserActivityWithType:);
    SEL resume = @selector(application:continueUserActivity:restorationHandler:);
    Method willMethod = class_getInstanceMethod(cls, will);
    Method resumeMethod = class_getInstanceMethod(cls, resume);
    // The pinned Tao delegate implements both. Fail closed if a future runtime changes it.
    if (!willMethod || !resumeMethod || avidNavigate) return false;
    avidNavigate = navigate;
    previousWillContinue = method_setImplementation(willMethod, (IMP)avidWillContinue);
    previousContinue = method_setImplementation(resumeMethod, (IMP)avidContinue);
    return true;
}

typedef void (*AvidSpotlightCompletion)(void *, const char *);
void avid_spotlight_apply(const char *json, void *context, AvidSpotlightCompletion complete) {
    @autoreleasepool {
        NSData *data = [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
        NSError *parseError = nil;
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:data options:0 error:&parseError];
        if (![request isKindOfClass:NSDictionary.class]) {
            complete(context, "Invalid Spotlight request.");
            return;
        }
        CSSearchableIndex *index = [[CSSearchableIndex alloc] initWithName:@"AvidLibrary"];
        void (^finished)(NSError *) = ^(NSError *error) {
            complete(context, error ? error.localizedDescription.UTF8String : NULL);
        };
        NSString *action = request[@"action"];
        if ([action isEqualToString:@"clear"]) {
            [index deleteAllSearchableItemsWithCompletionHandler:finished];
        } else if ([action isEqualToString:@"remove"]) {
            [index deleteSearchableItemsWithIdentifiers:request[@"ids"] completionHandler:finished];
        } else if ([action isEqualToString:@"index"]) {
            NSMutableArray<CSSearchableItem *> *items = [NSMutableArray array];
            for (NSDictionary *entry in request[@"items"]) {
                CSSearchableItemAttributeSet *attributes = [[CSSearchableItemAttributeSet alloc] initWithItemContentType:@"public.text"];
                attributes.title = entry[@"title"];
                NSString *author = entry[@"author"];
                attributes.authorNames = author.length ? @[author] : @[];
                attributes.contentDescription = author;
                attributes.keywords = @[@"Avid", entry[@"kind"]];
                CSSearchableItem *item = [[CSSearchableItem alloc] initWithUniqueIdentifier:entry[@"id"] domainIdentifier:request[@"domain"] attributeSet:attributes];
                [items addObject:item];
            }
            [index indexSearchableItems:items completionHandler:finished];
        } else {
            complete(context, "Unknown Spotlight request.");
        }
    }
}
