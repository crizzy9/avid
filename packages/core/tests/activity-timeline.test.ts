import {describe,it,expect,vi} from 'vitest';
import {BookOrbitClient} from '../src/bookorbit';
const session={profile:{id:'s',name:'Fixture',url:'https://books.example'},userId:'7',accessToken:'test'};
const reply=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
const duration={totalSeconds:120,readingSeconds:90,listeningSeconds:30};
describe('server activity history contract',()=>{
  it('reads an explicit ISO week with account authentication and cancellation',async()=>{
    const fetch=vi.fn(async()=>reply({year:2026,week:41,weekStart:'2026-10-05',weekEnd:'2026-10-11',items:[{sessionId:11,bookId:9,bookTitle:'Original book',bookFormat:'EPUB',bookSource:'ios',startedAt:'2026-10-09T12:00:00Z',endedAt:'2026-10-09T12:02:00Z',durationSeconds:120}]}));
    const client=new BookOrbitClient(session,{fetch,readOnly:true}),abort=new AbortController();
    expect((await client.getSessionTimeline({year:2026,week:41,signal:abort.signal})).items[0]).toMatchObject({sessionId:'11',bookId:'9',bookSource:'ios',durationSeconds:120});
    expect(fetch).toHaveBeenCalledWith('https://books.example/api/v1/user-statistics/session-timeline?year=2026&week=41',expect.objectContaining({signal:abort.signal}));
  });
  it('rejects invalid week values before making a request',async()=>{
    const fetch=vi.fn(),client=new BookOrbitClient(session,{fetch});
    for(const options of [{year:1969},{week:0},{week:54},{week:1.5}])await expect(client.getSessionTimeline(options)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('includes prior-year days in the current week without replacing the selected historical calendar',async()=>{
    const day=(day:string)=>({day,...duration,sessionsCount:1,bySource:{ios:120}});
    const current={year:2027,availableYears:[2025,2026,2027],days:[day('2027-01-01')]};
    const fetch=vi.fn(async(input:RequestInfo|URL)=>{
      const path=String(input);
      if(path.endsWith('activity-overview'))return reply({generatedAt:'2027-01-02T02:00:00Z',timezone:'America/New_York',snapshot:{today:duration,lastSevenDays:duration,previousSevenDays:duration,currentStreak:1,longestStreak:1,completedBooksYtd:0},calendar:current,sources:{windowDays:30,totals:duration,slices:[]}});
      if(path.endsWith('summary'))return reply({trackedBooks:1,startedBooks:1,inProgressBooks:1,completedBooks:0,meanProgressPercent:1});
      if(path.endsWith('/2025'))return reply({year:2025,availableYears:[],days:[day('2025-07-01')]});
      if(path.endsWith('/2026'))return reply({year:2026,availableYears:[],days:[day('2026-12-31')]});
      throw new Error(path);
    });
    const stats=await new BookOrbitClient(session,{fetch,readOnly:true}).getReadingStatistics(2025);
    expect(stats.calendar.year).toBe(2025);expect(stats.currentCalendar.year).toBe(2027);
    expect(stats.recentDays?.map(day=>day.day)).toEqual(['2026-12-31','2027-01-01']);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
